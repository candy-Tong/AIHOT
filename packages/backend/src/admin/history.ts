// 处理历史: every stored item with the furthest pipeline step it reached and why it stopped there.
// Read-only. Items are the articles table (one row per deduplicated item; repeats land in
// article_discoveries); fetch_runs gives what the fetches found before deduplication.
import type { AdminFactRow, AdminGroupMember, AdminGroups, AdminHistory, AdminHistoryDay, AdminHistoryRow, AdminStoryRow, BeforeJson } from "@aihot/contracts/admin";
import { SELECTION } from "@aihot/industry/selection";
import { sql } from "../db.ts";

/** The latest analysis of article `a`, as `an` (with the prefilter's own reason). */
export const LATEST_ANALYSIS = () => sql`LEFT JOIN LATERAL (SELECT relevance, score, reason_zh, output -> 'prefilter' ->> 'reason' AS prefilter_reason FROM analyses WHERE article_id = a.id ORDER BY id DESC LIMIT 1) an ON true`;

/** Over articles `a`, publications `p` and LATEST_ANALYSIS `an`: the furthest step reached (AdminHistoryOutcome). */
export const OUTCOME_SQL = () => sql`CASE
               WHEN a.processing_state = 'failed' THEN 'failed'
               WHEN a.processing_state = 'new' THEN 'pending'
               WHEN a.processing_state = 'blocked' OR an.relevance = 'block' THEN 'filtered'
               WHEN a.processing_state = 'skipped' THEN 'skipped'
               WHEN coalesce(p.selected, false) THEN 'selected'
               WHEN coalesce(p.score, an.score) IS NOT NULL THEN 'not_selected'
               ELSE 'unscored'
             END`;

/** The why of OUTCOME_SQL. */
export const REASON_SQL = () => sql`CASE
               WHEN a.processing_state = 'failed' THEN coalesce(a.processing_error, a.grouping_error)
               WHEN coalesce(p.selected, false) THEN coalesce(p.reason, an.reason_zh)
               WHEN a.processing_state = 'blocked' OR an.relevance = 'block' THEN coalesce(an.prefilter_reason, an.reason_zh)
               ELSE coalesce(an.reason_zh, an.prefilter_reason, a.processing_error, a.selection_value_reason)
             END`;

const PAGE = 50;
const OUTCOMES = new Set(["pending", "failed", "filtered", "skipped", "unscored", "not_selected", "selected"]);
const TZ = "Asia/Shanghai";

export interface HistoryFilters {
  source?: string;
  tier?: string;
  outcome?: string;
  from?: string; // YYYY-MM-DD, Beijing time
  to?: string;
  q?: string;
  sort?: string; // "discovered" (default) | "score"
  page?: number;
}

const day = (v: string | undefined) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);

export async function processingHistory(f: HistoryFilters): Promise<BeforeJson<AdminHistory>> {
  const page = Math.max(1, f.page ?? 1);
  const from = day(f.from);
  const to = day(f.to);
  const q = f.q?.trim() ? `%${f.q.trim()}%` : null;
  const outcome = f.outcome && OUTCOMES.has(f.outcome) ? f.outcome : null;
  const source = f.source || null;
  const tier = f.tier || null;
  const thresholds = SELECTION.thresholds;
  const order = f.sort === "score" ? sql`x.score DESC NULLS LAST, x.discovered_at DESC, x.id` : sql`x.discovered_at DESC, x.id`;
  const rows = await sql<BeforeJson<AdminHistoryRow>[]>`
    SELECT * FROM (
      SELECT a.id, coalesce(p.title, a.title) AS title, a.url, a.source_id, s.name AS source, s.tier, a.discovered_at,
             a.processing_state, a.body_status, a.grouping_status,
             ${OUTCOME_SQL()} AS outcome,
             ${REASON_SQL()} AS reason,
             an.relevance, coalesce(p.score, an.score)::float8 AS score,
             (${sql.json(thresholds as never)}::jsonb ->> s.tier)::float8 AS threshold,
             coalesce(p.selected, false) AS selected, p.visibility, p.story_id, p.fact_id,
             (SELECT count(*)::int FROM article_discoveries d WHERE d.article_id = a.id) - 1 AS rediscovered
      FROM articles a
      JOIN sources s ON s.id = a.source_id
      LEFT JOIN publications p ON p.article_id = a.id
      ${LATEST_ANALYSIS()}
      WHERE (${source}::text IS NULL OR a.source_id = ${source})
        AND (${tier}::text IS NULL OR s.tier = ${tier})
        AND (${from}::date IS NULL OR a.discovered_at >= (${from}::date)::timestamp AT TIME ZONE ${TZ})
        AND (${to}::date IS NULL OR a.discovered_at < (${to}::date + 1)::timestamp AT TIME ZONE ${TZ})
        AND (${q}::text IS NULL OR a.title ILIKE ${q} OR p.title ILIKE ${q} OR a.url ILIKE ${q})
    ) x
    WHERE (${outcome}::text IS NULL OR x.outcome = ${outcome})
    ORDER BY ${order}
    LIMIT ${PAGE + 1} OFFSET ${(page - 1) * PAGE}`;
  const days = await sql<BeforeJson<AdminHistoryDay>[]>`
    WITH a AS (
      SELECT (a.discovered_at AT TIME ZONE ${TZ})::date AS day, a.processing_state, coalesce(p.selected, false) AS selected,
             coalesce(p.score, an.score) AS score, an.relevance
      FROM articles a
      JOIN sources s ON s.id = a.source_id
      LEFT JOIN publications p ON p.article_id = a.id
      LEFT JOIN LATERAL (SELECT relevance, score FROM analyses WHERE article_id = a.id ORDER BY id DESC LIMIT 1) an ON true
      WHERE a.discovered_at >= coalesce((${from}::date)::timestamp AT TIME ZONE ${TZ}, now() - interval '14 days')
        AND (${to}::date IS NULL OR a.discovered_at < (${to}::date + 1)::timestamp AT TIME ZONE ${TZ})
        AND (${source}::text IS NULL OR a.source_id = ${source})
        AND (${tier}::text IS NULL OR s.tier = ${tier})
    ), r AS (
      SELECT (r.started_at AT TIME ZONE ${TZ})::date AS day, sum(r.found_count)::int AS found, sum(r.new_count)::int AS new_items
      FROM fetch_runs r
      WHERE r.started_at >= coalesce((${from}::date)::timestamp AT TIME ZONE ${TZ}, now() - interval '14 days')
        AND (${to}::date IS NULL OR r.started_at < (${to}::date + 1)::timestamp AT TIME ZONE ${TZ})
        AND (${source}::text IS NULL OR r.source_id = ${source})
      GROUP BY 1
    )
    SELECT to_char(coalesce(t.day, r.day), 'YYYY-MM-DD') AS day, coalesce(r.found, 0) AS found, coalesce(r.new_items, 0) AS new_items,
           coalesce(t.total, 0) AS total, coalesce(t.pending, 0) AS pending, coalesce(t.failed, 0) AS failed,
           coalesce(t.filtered, 0) AS filtered, coalesce(t.scored, 0) AS scored, coalesce(t.selected, 0) AS selected, t.top_score
    FROM (
      SELECT day, count(*)::int AS total,
             count(*) FILTER (WHERE processing_state = 'new')::int AS pending,
             count(*) FILTER (WHERE processing_state = 'failed')::int AS failed,
             count(*) FILTER (WHERE processing_state = 'blocked' OR relevance = 'block')::int AS filtered,
             count(score)::int AS scored, count(*) FILTER (WHERE selected)::int AS selected, max(score)::float8 AS top_score
      FROM a GROUP BY day
    ) t FULL JOIN r ON r.day = t.day
    ORDER BY 1 DESC`;
  const sources = await sql<{ id: string; name: string }[]>`SELECT id, name FROM sources ORDER BY name, id`;
  return { page, rows: rows.slice(0, PAGE), hasMore: rows.length > PAGE, days, sources, thresholds };
}

// Stories and facts (the 处理历史 tabs): the grouping the event step built, with every member article.

const GROUP_PAGE = 30;

export interface GroupFilters {
  id?: string;
  source?: string;
  selected?: string; // "yes" | "no"
  size?: string; // minimum member count
  from?: string;
  to?: string;
  q?: string;
  sort?: string; // "time" (default) | "score" | "size"
  page?: number;
}

function groupArgs(f: GroupFilters) {
  return {
    page: Math.max(1, f.page ?? 1),
    id: f.id && /^\d+$/.test(f.id) ? Number(f.id) : null,
    source: f.source || null,
    selected: f.selected === "yes" ? true : f.selected === "no" ? false : null,
    size: f.size && /^\d+$/.test(f.size) ? Number(f.size) : null,
    from: day(f.from),
    to: day(f.to),
    q: f.q?.trim() ? `%${f.q.trim()}%` : null,
  };
}

const groupTime = (by: "story" | "fact") => (by === "story" ? sql`x.latest_at` : sql`x.created_at`);

const groupOrder = (sort: string | undefined, by: "story" | "fact") =>
  sort === "score" ? sql`agg.top_score DESC NULLS LAST, ${groupTime(by)} DESC NULLS LAST, x.id DESC`
    : sort === "size" ? sql`agg.members DESC, ${groupTime(by)} DESC NULLS LAST, x.id DESC`
      : sql`${groupTime(by)} DESC NULLS LAST, x.id DESC`;

/** Member aggregates over the facts selected by `facts` (a WHERE on `f`). */
const memberAgg = (facts: ReturnType<typeof sql>, source: string | null) => sql`
  LEFT JOIN LATERAL (
    SELECT count(DISTINCT a.id)::int AS members, count(DISTINCT a.source_id)::int AS sources,
           (count(DISTINCT a.id) FILTER (WHERE p.selected))::int AS selected,
           max(coalesce(p.score, an.score))::float8 AS top_score,
           coalesce(bool_or(a.source_id = ${source}), false) AS has_source
    FROM facts f JOIN fact_articles fa ON fa.fact_id = f.id JOIN articles a ON a.id = fa.article_id
    LEFT JOIN publications p ON p.article_id = a.id
    LEFT JOIN LATERAL (SELECT score FROM analyses WHERE article_id = a.id ORDER BY id DESC LIMIT 1) an ON true
    WHERE ${facts}
  ) agg ON true`;

async function groupMembers(by: "story" | "fact", ids: number[]): Promise<Map<number, BeforeJson<AdminGroupMember>[]>> {
  const out = new Map<number, BeforeJson<AdminGroupMember>[]>();
  if (!ids.length) return out;
  const rows = await sql<(BeforeJson<AdminGroupMember> & { group_id: number })[]>`
    SELECT ${by === "story" ? sql`f.story_id` : sql`f.id`} AS group_id, a.id, coalesce(p.title, a.title) AS title, s.name AS source, s.tier,
           a.discovered_at, fa.fact_id, fa.role, fa.evidence, coalesce(p.score, an.score)::float8 AS score,
           ${OUTCOME_SQL()} AS outcome, ${REASON_SQL()} AS reason, coalesce(p.selected, false) AS selected, p.visibility,
           a.grouping_status, a.grouping_error, gd.verdict, gd.candidates, gd.created_at AS decided_at
    FROM facts f
    JOIN fact_articles fa ON fa.fact_id = f.id
    JOIN articles a ON a.id = fa.article_id
    JOIN sources s ON s.id = a.source_id
    LEFT JOIN publications p ON p.article_id = a.id
    ${LATEST_ANALYSIS()}
    LEFT JOIN LATERAL (SELECT verdict, candidates, created_at FROM grouping_decisions WHERE article_id = a.id ORDER BY id DESC LIMIT 1) gd ON true
    WHERE ${by === "story" ? sql`f.story_id = ANY(${ids})` : sql`f.id = ANY(${ids})`}
    ORDER BY a.discovered_at, a.id`;
  for (const { group_id, ...m } of rows) {
    const list = out.get(group_id) ?? [];
    if (!list.some((x) => x.id === m.id)) list.push(m);
    out.set(group_id, list);
  }
  return out;
}

const groupSources = () => sql<{ id: string; name: string }[]>`SELECT id, name FROM sources ORDER BY name, id`;

export async function historyStories(f: GroupFilters): Promise<BeforeJson<AdminGroups<AdminStoryRow>>> {
  const g = groupArgs(f);
  const rows = await sql<Omit<BeforeJson<AdminStoryRow>, "items">[]>`
    SELECT x.id::int, x.public_id, x.title, x.summary, x.origin, x.first_report_at, x.latest_at,
           (SELECT count(*)::int FROM facts c WHERE c.story_id = x.id) AS facts,
           coalesce(agg.members, 0) AS members, coalesce(agg.sources, 0) AS sources, coalesce(agg.selected, 0) AS selected, agg.top_score,
           (SELECT count(*)::int FROM stories m WHERE m.merged_into = x.id) AS merged
    FROM stories x
    ${memberAgg(sql`f.story_id = x.id`, g.source)}
    WHERE x.merged_into IS NULL
      AND (${g.id}::bigint IS NULL OR x.id = ${g.id})
      AND (${g.q}::text IS NULL OR x.title ILIKE ${g.q} OR x.summary ILIKE ${g.q} OR x.digest ILIKE ${g.q})
      AND (${g.from}::date IS NULL OR x.latest_at >= (${g.from}::date)::timestamp AT TIME ZONE ${TZ})
      AND (${g.to}::date IS NULL OR x.latest_at < (${g.to}::date + 1)::timestamp AT TIME ZONE ${TZ})
      AND (${g.source}::text IS NULL OR agg.has_source)
      AND (${g.selected}::boolean IS NULL OR (coalesce(agg.selected, 0) > 0) = ${g.selected})
      AND (${g.size}::int IS NULL OR coalesce(agg.members, 0) >= ${g.size})
    ORDER BY ${groupOrder(f.sort, "story")}
    LIMIT ${GROUP_PAGE + 1} OFFSET ${(g.page - 1) * GROUP_PAGE}`;
  const page = rows.slice(0, GROUP_PAGE);
  const members = await groupMembers("story", page.map((r) => r.id));
  return { page: g.page, rows: page.map((r) => ({ ...r, items: members.get(r.id) ?? [] })), hasMore: rows.length > GROUP_PAGE, sources: await groupSources() };
}

export async function historyFacts(f: GroupFilters & { story?: string }): Promise<BeforeJson<AdminGroups<AdminFactRow>>> {
  const g = groupArgs(f);
  const story = f.story && /^\d+$/.test(f.story) ? Number(f.story) : null;
  const rows = await sql<Omit<BeforeJson<AdminFactRow>, "items">[]>`
    SELECT x.id::int, x.public_id, x.title, x.subject, x.action, x.object, x.occurred_at, x.created_at, x.manual,
           x.story_id::int, st.title AS story_title,
           coalesce(agg.members, 0) AS members, coalesce(agg.sources, 0) AS sources, coalesce(agg.selected, 0) AS selected, agg.top_score
    FROM facts x
    LEFT JOIN stories st ON st.id = x.story_id
    ${memberAgg(sql`f.id = x.id`, g.source)}
    WHERE (${g.id}::bigint IS NULL OR x.id = ${g.id})
      AND (${story}::bigint IS NULL OR x.story_id = ${story})
      AND (${g.q}::text IS NULL OR x.title ILIKE ${g.q} OR x.subject ILIKE ${g.q} OR x.object ILIKE ${g.q})
      AND (${g.from}::date IS NULL OR ${groupTime("fact")} >= (${g.from}::date)::timestamp AT TIME ZONE ${TZ})
      AND (${g.to}::date IS NULL OR ${groupTime("fact")} < (${g.to}::date + 1)::timestamp AT TIME ZONE ${TZ})
      AND (${g.source}::text IS NULL OR agg.has_source)
      AND (${g.selected}::boolean IS NULL OR (coalesce(agg.selected, 0) > 0) = ${g.selected})
      AND (${g.size}::int IS NULL OR coalesce(agg.members, 0) >= ${g.size})
    ORDER BY ${groupOrder(f.sort, "fact")}
    LIMIT ${GROUP_PAGE + 1} OFFSET ${(g.page - 1) * GROUP_PAGE}`;
  const page = rows.slice(0, GROUP_PAGE);
  const members = await groupMembers("fact", page.map((r) => r.id));
  return { page: g.page, rows: page.map((r) => ({ ...r, items: members.get(r.id) ?? [] })), hasMore: rows.length > GROUP_PAGE, sources: await groupSources() };
}

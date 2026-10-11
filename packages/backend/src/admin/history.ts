// 处理历史: every stored item with the furthest pipeline step it reached and why it stopped there.
// Read-only. Items are the articles table (one row per deduplicated item; repeats land in
// article_discoveries); fetch_runs gives what the fetches found before deduplication.
import type { AdminHistory, AdminHistoryDay, AdminHistoryRow, BeforeJson } from "@aihot/contracts/admin";
import { SELECTION } from "@aihot/industry/selection";
import { sql } from "../db.ts";

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
             CASE
               WHEN a.processing_state = 'failed' THEN 'failed'
               WHEN a.processing_state = 'new' THEN 'pending'
               WHEN a.processing_state = 'blocked' OR an.relevance = 'block' THEN 'filtered'
               WHEN a.processing_state = 'skipped' THEN 'skipped'
               WHEN coalesce(p.selected, false) THEN 'selected'
               WHEN coalesce(p.score, an.score) IS NOT NULL THEN 'not_selected'
               ELSE 'unscored'
             END AS outcome,
             CASE
               WHEN a.processing_state = 'failed' THEN coalesce(a.processing_error, a.grouping_error)
               WHEN coalesce(p.selected, false) THEN coalesce(p.reason, an.reason_zh)
               WHEN a.processing_state = 'blocked' OR an.relevance = 'block' THEN coalesce(an.prefilter_reason, an.reason_zh)
               ELSE coalesce(an.reason_zh, an.prefilter_reason, a.processing_error, a.selection_value_reason)
             END AS reason,
             an.relevance, coalesce(p.score, an.score)::float8 AS score,
             (${sql.json(thresholds as never)}::jsonb ->> s.tier)::float8 AS threshold,
             coalesce(p.selected, false) AS selected, p.visibility, p.story_id,
             (SELECT count(*)::int FROM article_discoveries d WHERE d.article_id = a.id) - 1 AS rediscovered
      FROM articles a
      JOIN sources s ON s.id = a.source_id
      LEFT JOIN publications p ON p.article_id = a.id
      LEFT JOIN LATERAL (SELECT relevance, score, reason_zh, output -> 'prefilter' ->> 'reason' AS prefilter_reason FROM analyses WHERE article_id = a.id ORDER BY id DESC LIMIT 1) an ON true
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

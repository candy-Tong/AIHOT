import { useState } from "react";
import { SITE } from "@aihot/site";
import { Form, Link, useNavigate, useSearchParams } from "react-router";
import type { Route } from "./+types/history";
import type { AdminFactRow, AdminGroupMember, AdminGroups, AdminHistory, AdminHistoryOutcome, AdminHistoryRow, AdminStoryRow } from "@aihot/contracts/admin";
import { adminGet } from "../../lib/admin.server";
import { bj, num } from "../../features/admin/format";
import { TIER_LABEL, VISIBILITY_LABEL } from "../../features/admin/labels";
import { AdminPage, Badge, Button, Card, DataTable, FilterChips, Input, Pager, Select } from "../../features/admin/ui";

type Tab = "article" | "story" | "fact";
type Data =
  | { tab: "article"; data: AdminHistory }
  | { tab: "story"; data: AdminGroups<AdminStoryRow> }
  | { tab: "fact"; data: AdminGroups<AdminFactRow> };

export async function loader({ request }: Route.LoaderArgs): Promise<Data> {
  const url = new URL(request.url);
  const tab = url.searchParams.get("tab");
  if (tab === "story") return { tab, data: await adminGet<AdminGroups<AdminStoryRow>>(request, `/api/admin/history/stories${url.search}`) };
  if (tab === "fact") return { tab, data: await adminGet<AdminGroups<AdminFactRow>>(request, `/api/admin/history/facts${url.search}`) };
  return { tab: "article", data: await adminGet<AdminHistory>(request, `/api/admin/history${url.search}`) };
}

const TABS: Array<{ value: Tab; label: string }> = [
  { value: "article", label: "文章" },
  { value: "story", label: "Story（事件）" },
  { value: "fact", label: "Fact（事实）" },
];

const VERDICT_LABEL: Record<string, string> = {
  "new-story": "新建事件", "new-fact-in-story": "事件内新事实", "same-fact": "同一事实", "same-url": "同一链接", roundup: "汇总稿", kept: "保留原归属",
};

export const meta: Route.MetaFunction = () => [{ title: `处理历史 · ${SITE.name} 后台` }];

const OUTCOME: Record<AdminHistoryOutcome, { label: string; tone: "accent" | "ok" | "warn" | "bad" | "muted" | "info" }> = {
  selected: { label: "入选精选", tone: "accent" },
  not_selected: { label: "未达门槛", tone: "info" },
  unscored: { label: "未评分", tone: "muted" },
  filtered: { label: "预筛拦截", tone: "warn" },
  skipped: { label: "跳过", tone: "muted" },
  failed: { label: "处理失败", tone: "bad" },
  pending: { label: "待处理", tone: "muted" },
};

function Reason({ text }: { text: string | null }) {
  const [open, setOpen] = useState(false);
  if (!text) return <span className="text-ink-4">—</span>;
  const long = text.length > 80;
  return (
    <div className="min-w-[240px] max-w-[420px] text-[12.5px] leading-relaxed text-ink-3">
      {open || !long ? text : `${text.slice(0, 80)}…`}
      {long && (
        <button type="button" className="ml-1 text-accent hover:underline" onClick={(e) => { e.stopPropagation(); setOpen(!open); }}>
          {open ? "收起" : "展开"}
        </button>
      )}
    </div>
  );
}

function Score({ r }: { r: AdminHistoryRow }) {
  if (r.score === null) return <span className="text-ink-4">—</span>;
  const pass = r.threshold !== null && r.score >= r.threshold;
  return (
    <span className="whitespace-nowrap" title={r.threshold === null ? "该分级不参与精选" : `${TIER_LABEL[r.tier] ?? r.tier} 门槛 ${r.threshold}`}>
      <span className={pass ? "font-medium text-accent" : "text-ink"}>{r.score}</span>
      <span className="text-[11.5px] text-ink-4"> / {r.threshold ?? "—"}</span>
    </span>
  );
}

function ArticleTab({ data }: { data: AdminHistory }) {
  const { rows, days, sources, page, hasMore, thresholds } = data;
  const [sp] = useSearchParams();
  const navigate = useNavigate();
  const set = (k: string, v: string) => {
    const next = new URLSearchParams(sp);
    if (v) next.set(k, v);
    else next.delete(k);
    next.delete("page");
    navigate(`?${next}`, { preventScrollReset: true });
  };
  return (
    <>
      <p className="mb-4 text-[13px] text-ink-3">{`门槛（平均分）：${Object.entries(thresholds).map(([t, v]) => `${TIER_LABEL[t] ?? t} ${v}`).join(" · ")}。重复内容合并进同一条，计入“重复发现”。`}</p>
      <Card title="每日汇总" pad={false} className="mb-5" right={<span>{sp.get("from") || sp.get("to") ? "按所选日期" : "最近 14 天"}（北京时间）</span>}>
        <DataTable
          dense
          rows={days}
          rowKey={(d) => d.day}
          empty="这段时间没有采集记录"
          onRowClick={(d) => { const next = new URLSearchParams(sp); next.set("from", d.day); next.set("to", d.day); next.delete("page"); navigate(`?${next}`); }}
          columns={[
            { key: "d", label: "日期", render: (d) => <span className="num whitespace-nowrap">{d.day}</span> },
            { key: "f", label: <span title="每次抓取看到的条目累加，含早已入库的旧条目">抓取（累计）</span>, align: "right", render: (d) => num(d.found) },
            { key: "n", label: "新条目", align: "right", render: (d) => num(d.new_items) },
            { key: "t", label: "入库", align: "right", render: (d) => num(d.total) },
            { key: "p", label: "待处理", align: "right", render: (d) => num(d.pending) },
            { key: "x", label: "失败", align: "right", render: (d) => (d.failed ? <span className="text-hot">{num(d.failed)}</span> : "0") },
            { key: "b", label: "预筛拦截", align: "right", render: (d) => num(d.filtered) },
            { key: "s", label: "已评分", align: "right", render: (d) => num(d.scored) },
            { key: "e", label: "入选", align: "right", render: (d) => (d.selected ? <span className="font-medium text-accent">{num(d.selected)}</span> : "0") },
            { key: "m", label: "最高分", align: "right", render: (d) => d.top_score ?? "—" },
          ]}
        />
      </Card>

      <Card pad={false}>
        <div className="flex flex-col gap-3 border-b border-line p-3">
          <Form method="get" className="flex flex-wrap items-center gap-2" preventScrollReset>
            {["source", "tier", "outcome", "sort"].map((k) => sp.get(k) && <input key={k} type="hidden" name={k} value={sp.get(k)!} />)}
            <Input name="q" defaultValue={sp.get("q") ?? ""} placeholder="标题或链接关键词" aria-label="关键词" className="!w-64" />
            <Input type="date" name="from" defaultValue={sp.get("from") ?? ""} aria-label="开始日期" className="!w-40" />
            <span className="text-ink-4">至</span>
            <Input type="date" name="to" defaultValue={sp.get("to") ?? ""} aria-label="结束日期" className="!w-40" />
            <Button type="submit" tone="primary">筛选</Button>
            {[...sp.keys()].some((k) => k !== "page") && <Button type="button" onClick={() => navigate("?")}>清除</Button>}
          </Form>
          <div className="flex flex-wrap items-center gap-3">
            <FilterChips param="outcome" options={[{ value: "", label: "全部" }, ...Object.entries(OUTCOME).map(([value, o]) => ({ value, label: o.label }))]} />
            <Select aria-label="信源" className="!w-auto" value={sp.get("source") ?? ""} onChange={(e) => set("source", e.target.value)}>
              <option value="">全部信源</option>
              {sources.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
            <Select aria-label="分级" className="!w-auto" value={sp.get("tier") ?? ""} onChange={(e) => set("tier", e.target.value)}>
              <option value="">全部分级</option>
              {Object.entries(TIER_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </Select>
            <Select aria-label="排序" className="!w-auto" value={sp.get("sort") ?? ""} onChange={(e) => set("sort", e.target.value)}>
              <option value="">按发现时间</option>
              <option value="score">按分数</option>
            </Select>
          </div>
        </div>
        <DataTable
          rows={rows}
          rowKey={(r) => r.id}
          empty="没有符合条件的内容"
          columns={[
            { key: "d", label: "发现（北京时间）", render: (r) => <span className="num whitespace-nowrap text-[12.5px]">{bj(r.discovered_at, true)}</span> },
            {
              key: "src",
              label: "信源",
              render: (r) => (
                <div className="whitespace-nowrap">
                  {r.source}
                  <div className="mt-0.5"><Badge tone="info">{TIER_LABEL[r.tier] ?? r.tier}</Badge></div>
                </div>
              ),
            },
            {
              key: "t",
              label: "标题",
              render: (r) => (
                <div className="min-w-[260px] max-w-[420px]">
                  <Link to={`/admin/content/${r.id}`} className="line-clamp-2 font-medium text-ink hover:text-accent">{r.title}</Link>
                  {r.rediscovered > 0 && <div className="text-[11.5px] text-ink-4">重复发现 {r.rediscovered} 次（已合并）</div>}
                </div>
              ),
            },
            {
              key: "o",
              label: "结果",
              render: (r) => (
                <span className="flex flex-wrap gap-1">
                  <Badge tone={OUTCOME[r.outcome].tone}>{OUTCOME[r.outcome].label}</Badge>
                  {r.story_id !== null && <Link to={`?tab=story&id=${r.story_id}`} title={`Story #${r.story_id}`}><Badge tone="muted">归入事件 #{r.story_id}</Badge></Link>}
                  {r.fact_id !== null && <Link to={`?tab=fact&id=${r.fact_id}`} title={`Fact #${r.fact_id}`}><Badge tone="muted">Fact #{r.fact_id}</Badge></Link>}
                  {r.grouping_status === "failed" && <Badge tone="bad">归组失败</Badge>}
                  {r.visibility && r.visibility !== "public" && <Badge tone="warn">{VISIBILITY_LABEL[r.visibility] ?? r.visibility}</Badge>}
                  {r.body_status !== "ok" && <Badge tone="muted" title="正文状态">正文 {r.body_status}</Badge>}
                </span>
              ),
            },
            { key: "s", label: "分数 / 门槛", align: "right", render: (r) => <Score r={r} /> },
            { key: "r", label: "原因", render: (r) => <Reason text={r.reason} /> },
          ]}
        />
      </Card>
      <Pager page={page} hasMore={hasMore} />
    </>
  );
}

function Members({ items }: { items: AdminGroupMember[] }) {
  return (
    <DataTable
      dense
      rows={items}
      rowKey={(m) => `${m.fact_id}:${m.id}`}
      empty="没有成员文章"
      columns={[
        { key: "d", label: "发现", render: (m) => <span className="num whitespace-nowrap text-[12px]">{bj(m.discovered_at, true)}</span> },
        { key: "s", label: "信源", render: (m) => <span className="whitespace-nowrap">{m.source} <Badge tone="info">{TIER_LABEL[m.tier] ?? m.tier}</Badge></span> },
        {
          key: "t",
          label: "文章",
          render: (m) => (
            <div className="min-w-[240px] max-w-[380px]">
              <Link to={`/admin/content/${m.id}`} className="line-clamp-2 text-ink hover:text-accent">{m.title}</Link>
              <div className="text-[11.5px] text-ink-4">Fact #{m.fact_id} · {m.role}{m.evidence ? ` · ${m.evidence}` : ""}</div>
            </div>
          ),
        },
        {
          key: "o",
          label: "结果",
          render: (m) => (
            <span className="flex flex-wrap gap-1">
              <Badge tone={OUTCOME[m.outcome].tone}>{OUTCOME[m.outcome].label}</Badge>
              {m.visibility && m.visibility !== "public" && <Badge tone="warn">{VISIBILITY_LABEL[m.visibility] ?? m.visibility}</Badge>}
            </span>
          ),
        },
        { key: "sc", label: "分数", align: "right", render: (m) => m.score ?? "—" },
        {
          key: "g",
          label: "归组判断",
          render: (m) => (
            <div className="min-w-[160px] text-[12px] text-ink-3">
              {m.verdict ? <Badge tone="muted">{VERDICT_LABEL[m.verdict] ?? m.verdict}</Badge> : <span className="text-ink-4">—</span>}
              {Array.isArray(m.candidates) && m.candidates.length > 0 && (
                <div className="mt-0.5">
                  {(m.candidates as Array<{ id?: number; relation?: string; confidence?: number }>).slice(0, 3).map((c, i) => (
                    <div key={i}>候选 #{c.id ?? "?"} {c.relation ?? ""}{c.confidence !== undefined ? ` · 置信 ${c.confidence}` : ""}</div>
                  ))}
                </div>
              )}
              {m.grouping_status === "failed" && <div className="text-hot">归组失败{m.grouping_error ? `：${m.grouping_error.slice(0, 120)}` : ""}</div>}
            </div>
          ),
        },
        { key: "r", label: "原因", render: (m) => <Reason text={m.reason} /> },
      ]}
    />
  );
}

function GroupFilters({ data, tab }: { data: AdminGroups<unknown>; tab: "story" | "fact" }) {
  const [sp] = useSearchParams();
  const navigate = useNavigate();
  const set = (k: string, v: string) => {
    const next = new URLSearchParams(sp);
    if (v) next.set(k, v);
    else next.delete(k);
    next.delete("page");
    navigate(`?${next}`, { preventScrollReset: true });
  };
  return (
    <div className="mb-4 flex flex-col gap-3">
      <Form method="get" className="flex flex-wrap items-center gap-2" preventScrollReset>
        {["tab", "source", "selected", "sort", "story"].map((k) => sp.get(k) && <input key={k} type="hidden" name={k} value={sp.get(k)!} />)}
        <Input name="q" defaultValue={sp.get("q") ?? ""} placeholder={tab === "story" ? "事件标题或摘要" : "事实标题、主体或对象"} aria-label="关键词" className="!w-64" />
        <Input name="id" defaultValue={sp.get("id") ?? ""} placeholder="ID" aria-label="ID" className="!w-24" />
        <Input type="date" name="from" defaultValue={sp.get("from") ?? ""} aria-label="开始日期" className="!w-40" />
        <span className="text-ink-4">至</span>
        <Input type="date" name="to" defaultValue={sp.get("to") ?? ""} aria-label="结束日期" className="!w-40" />
        <Input type="number" min={1} name="size" defaultValue={sp.get("size") ?? ""} placeholder="最少文章数" aria-label="最少文章数" className="!w-32" />
        <Button type="submit" tone="primary">筛选</Button>
        {[...sp.keys()].some((k) => k !== "page" && k !== "tab") && <Button type="button" onClick={() => navigate(`?tab=${tab}`)}>清除</Button>}
      </Form>
      <div className="flex flex-wrap items-center gap-3">
        <FilterChips param="selected" options={[{ value: "", label: "全部" }, { value: "yes", label: "含精选" }, { value: "no", label: "无精选" }]} />
        <Select aria-label="信源" className="!w-auto" value={sp.get("source") ?? ""} onChange={(e) => set("source", e.target.value)}>
          <option value="">全部信源</option>
          {data.sources.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </Select>
        <Select aria-label="排序" className="!w-auto" value={sp.get("sort") ?? ""} onChange={(e) => set("sort", e.target.value)}>
          <option value="">按时间</option>
          <option value="score">按最高分</option>
          <option value="size">按文章数</option>
        </Select>
      </div>
    </div>
  );
}

function GroupStats({ members, sources, selected, top }: { members: number; sources: number; selected: number; top: number | null }) {
  return (
    <span className="flex flex-wrap gap-1">
      <Badge>{members} 篇 · {sources} 个信源</Badge>
      {selected > 0 ? <Badge tone="accent">精选 {selected}</Badge> : <Badge tone="muted">无精选</Badge>}
      <Badge tone="info">最高分 {top ?? "—"}</Badge>
    </span>
  );
}

function StoryTab({ data }: { data: AdminGroups<AdminStoryRow> }) {
  const [sp] = useSearchParams();
  return (
    <>
      <GroupFilters data={data} tab="story" />
      {data.rows.length === 0 && <Card><span className="text-ink-3">没有符合条件的事件</span></Card>}
      <div className="space-y-3">
        {data.rows.map((r) => (
          <Card key={r.id} pad={false}>
            <details open={data.rows.length === 1 || sp.get("id") === String(r.id)}>
              <summary className="cursor-pointer list-none p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="font-medium text-ink">{r.title}</div>
                    <div className="mt-0.5 text-[11.5px] text-ink-4">
                      Story #{r.id} · {r.facts} 个事实 · 首报 {r.first_report_at ? bj(r.first_report_at, true) : "—"} · 最新 {r.latest_at ? bj(r.latest_at, true) : "—"} · {r.origin}
                      {r.merged > 0 && ` · 合并了 ${r.merged} 个事件`}
                    </div>
                  </div>
                  <GroupStats members={r.members} sources={r.sources} selected={r.selected} top={r.top_score} />
                </div>
                {r.summary && <p className="mt-2 line-clamp-3 text-[12.5px] leading-relaxed text-ink-3">{r.summary}</p>}
              </summary>
              <div className="border-t border-line">
                <div className="flex gap-3 px-3 py-2 text-[12px]">
                  <Link to={`?tab=fact&story=${r.id}`} className="text-accent hover:underline">查看这个事件的事实</Link>
                  {r.selected > 0 && <a href={`/story/${r.public_id}`} target="_blank" rel="noreferrer" className="text-accent hover:underline">公开页面</a>}
                </div>
                <Members items={r.items} />
              </div>
            </details>
          </Card>
        ))}
      </div>
      <Pager page={data.page} hasMore={data.hasMore} />
    </>
  );
}

function FactTab({ data }: { data: AdminGroups<AdminFactRow> }) {
  const [sp] = useSearchParams();
  return (
    <>
      <GroupFilters data={data} tab="fact" />
      {sp.get("story") && <p className="mb-3 text-[12.5px] text-ink-3">只显示 Story #{sp.get("story")} 的事实。</p>}
      {data.rows.length === 0 && <Card><span className="text-ink-3">没有符合条件的事实</span></Card>}
      <div className="space-y-3">
        {data.rows.map((r) => (
          <Card key={r.id} pad={false}>
            <details open={data.rows.length === 1 || sp.get("id") === String(r.id)}>
              <summary className="cursor-pointer list-none p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="font-medium text-ink">{r.title}</div>
                    <div className="mt-0.5 text-[11.5px] text-ink-4">
                      Fact #{r.id} · {[r.subject, r.action, r.object].filter(Boolean).join(" / ") || "—"} · 事件时间 {r.occurred_at ? bj(r.occurred_at, true) : "—"} · 建立 {bj(r.created_at, true)}
                      {r.manual && " · 人工"}
                    </div>
                    {r.story_id !== null && (
                      <Link to={`?tab=story&id=${r.story_id}`} className="text-[12px] text-accent hover:underline">属于 Story #{r.story_id}：{r.story_title}</Link>
                    )}
                  </div>
                  <GroupStats members={r.members} sources={r.sources} selected={r.selected} top={r.top_score} />
                </div>
              </summary>
              <div className="border-t border-line"><Members items={r.items} /></div>
            </details>
          </Card>
        ))}
      </div>
      <Pager page={data.page} hasMore={data.hasMore} />
    </>
  );
}

export default function History({ loaderData }: Route.ComponentProps) {
  const [sp] = useSearchParams();
  const tab = loaderData.tab;
  const to = (t: Tab) => (t === "article" ? "?" : `?tab=${t}`);
  return (
    <AdminPage
      title="处理历史"
      subtitle="每一条采集到的内容走到了哪一步、为什么停在那里；以及它们被归成的 Story（事件）和 Fact（事实）、归组判断和入选情况。"
    >
      <div className="mb-5 flex gap-1 border-b border-line" role="tablist">
        {TABS.map((t) => (
          <Link
            key={t.value}
            to={to(t.value)}
            role="tab"
            aria-selected={tab === t.value}
            className={`-mb-px border-b-2 px-3 py-2 text-[13.5px] ${tab === t.value ? "border-accent font-medium text-ink" : "border-transparent text-ink-3 hover:text-ink"}`}
          >
            {t.label}
          </Link>
        ))}
        {sp.get("id") && tab !== "article" && <span className="ml-auto self-center text-[12px] text-ink-4">按 ID 筛选：#{sp.get("id")}</span>}
      </div>
      {loaderData.tab === "article" && <ArticleTab data={loaderData.data} />}
      {loaderData.tab === "story" && <StoryTab data={loaderData.data} />}
      {loaderData.tab === "fact" && <FactTab data={loaderData.data} />}
    </AdminPage>
  );
}

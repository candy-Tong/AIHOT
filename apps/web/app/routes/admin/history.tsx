import { useState } from "react";
import { SITE } from "@aihot/site";
import { Form, Link, useNavigate, useSearchParams } from "react-router";
import type { Route } from "./+types/history";
import type { AdminHistory, AdminHistoryOutcome, AdminHistoryRow } from "@aihot/contracts/admin";
import { adminGet } from "../../lib/admin.server";
import { bj, num } from "../../features/admin/format";
import { TIER_LABEL, VISIBILITY_LABEL } from "../../features/admin/labels";
import { AdminPage, Badge, Button, Card, DataTable, FilterChips, Input, Pager, Select } from "../../features/admin/ui";

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  return adminGet<AdminHistory>(request, `/api/admin/history${url.search}`);
}

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

export default function History({ loaderData }: Route.ComponentProps) {
  const { rows, days, sources, page, hasMore, thresholds } = loaderData;
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
    <AdminPage
      title="处理历史"
      subtitle={`每一条采集到的内容走到了哪一步、为什么停在那里：待处理、失败、预筛拦截、未评分、未达门槛、入选。门槛（平均分）：${Object.entries(thresholds).map(([t, v]) => `${TIER_LABEL[t] ?? t} ${v}`).join(" · ")}。重复内容合并进同一条，计入“重复发现”。`}
    >
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
                  {r.story_id !== null && <Badge tone="muted" title={`事件 #${r.story_id}`}>归入事件</Badge>}
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
    </AdminPage>
  );
}

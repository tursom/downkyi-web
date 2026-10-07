import { duration } from "./format";
import { Thumbnail } from "./components";
import type { KnownEntries, ParsedEntry } from "./types";

const knownLabel = { downloaded: "已下载", queued: "已在队列" } as const;

export default function DiscoveryPicker({ entries, selected, setSelected, disabled, known = {} }: {
  entries: ParsedEntry[];
  selected: string[];
  setSelected: (ids: string[]) => void;
  disabled: boolean;
  /** Videos that already have a task; shown for context but not selectable. */
  known?: KnownEntries;
}) {
  const groups = [...new Set(entries.map((entry) => entry.group))];
  const selectable = entries.filter((entry) => !known[entry.url]);
  const all = selectable.length > 0 && selectable.every((entry) => selected.includes(entry.id));
  return <section className="entry-picker" aria-label="待解析项目">
    <div className="picker-heading"><h3>选择待解析项目</h3><span>已选 {selected.length} / {selectable.length}</span></div>
    <p>支持全选，所选项目将自动分批解析。</p>
    <button type="button" className="button secondary" disabled={disabled || !selectable.length} onClick={() => setSelected(all ? [] : selectable.map((entry) => entry.id))}>
      {all ? "取消全选" : "全选"}
    </button>
    {!entries.length && <p>没有找到视频项目，请更换链接。</p>}
    {groups.map((group) => <div className="entry-group" key={group}>
      <div className="entry-group-heading"><strong>{group || "全部项目"}</strong></div>
      {entries.filter((entry) => entry.group === group).map((entry) => {
        const state = known[entry.url];
        return <label className={`entry-choice discovery-choice${state ? " known" : ""}`} key={entry.id}>
          <input type="checkbox" aria-label={entry.title} disabled={disabled || !!state} checked={!state && selected.includes(entry.id)} onChange={() => setSelected(selected.includes(entry.id) ? selected.filter((id) => id !== entry.id) : [...selected, entry.id])} />
          <Thumbnail src={entry.thumbnail} title={entry.title} />
          <span className="entry-title">{entry.title}<small>{state ? knownLabel[state] : entry.resolution === "pending" ? "待解析" : entry.available ? "资源已就绪" : "可重新解析"}</small></span>
          <span className="entry-duration">{duration(entry.duration)}</span>
        </label>;
      })}
    </div>)}
  </section>;
}

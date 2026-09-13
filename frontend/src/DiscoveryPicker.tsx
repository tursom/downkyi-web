import { duration } from "./format";
import { Thumbnail } from "./components";
import type { ParsedEntry } from "./types";

export default function DiscoveryPicker({ entries, selected, setSelected, disabled }: {
  entries: ParsedEntry[];
  selected: string[];
  setSelected: (ids: string[]) => void;
  disabled: boolean;
}) {
  const groups = [...new Set(entries.map((entry) => entry.group))];
  return <section className="entry-picker" aria-label="待解析项目">
    <div className="picker-heading"><h3>选择待解析项目</h3><span>已选 {selected.length} / {entries.length}</span></div>
    <p>单次最多选择 50 项。</p>
    <button type="button" className="button secondary" disabled={disabled || !entries.length} onClick={() => setSelected(selected.length === entries.length ? [] : entries.map((entry) => entry.id))}>
      {selected.length === entries.length && entries.length ? "取消全选" : "全选"}
    </button>
    {selected.length > 50 && <p className="notice warning" role="alert">单次最多解析 50 项，当前已选 {selected.length} 项，请减少选择。</p>}
    {!entries.length && <p>没有找到视频项目，请更换链接。</p>}
    {groups.map((group) => <div className="entry-group" key={group}>
      <div className="entry-group-heading"><strong>{group || "全部项目"}</strong></div>
      {entries.filter((entry) => entry.group === group).map((entry) => <label className="entry-choice discovery-choice" key={entry.id}>
        <input type="checkbox" aria-label={entry.title} disabled={disabled} checked={selected.includes(entry.id)} onChange={() => setSelected(selected.includes(entry.id) ? selected.filter((id) => id !== entry.id) : [...selected, entry.id])} />
        <Thumbnail src={entry.thumbnail} title={entry.title} />
        <span className="entry-title">{entry.title}<small>{entry.resolution === "pending" ? "待解析" : entry.available ? "资源已就绪" : "可重新解析"}</small></span>
        <span className="entry-duration">{duration(entry.duration)}</span>
      </label>)}
    </div>)}
  </section>;
}

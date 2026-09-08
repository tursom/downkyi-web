import { ChevronDown, ChevronRight, LockKeyhole, Search } from "lucide-react";
import { useState } from "react";
import { duration } from "./format";
import type { DownloadMode, ParsedEntry } from "./types";
export function eligible(entry: ParsedEntry, mode: DownloadMode) {
  return entry.available && (mode === "audio" || entry.qualities.length > 0);
}
export function qualityName(value: number | string) {
  return value === "best"
    ? "最佳可用画质"
    : String(value) === "2160"
      ? "4K (2160P)"
      : `${value}P`;
}
export default function EntryPicker({
  entries,
  selected,
  setSelected,
  mode,
}: {
  entries: ParsedEntry[];
  selected: string[];
  setSelected: (ids: string[]) => void;
  mode: DownloadMode;
}) {
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const groups = [...new Set(entries.map((entry) => entry.group))];
  const matching = entries.filter((entry) =>
    `${entry.title} ${entry.group}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  const available = entries.filter((entry) => eligible(entry, mode));
  const count = available.filter((entry) => selected.includes(entry.id)).length;
  return (
    <section className="entry-picker" aria-label="下载项目">
      <div className="picker-heading">
        <h3>选择项目</h3>
        <span>
          已选 {count} / {available.length}
        </span>
      </div>
      <label className="entry-search">
        <Search size={15} />
        <input
          aria-label="搜索分 P 或剧集"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索分 P 或剧集"
        />
      </label>
      {groups.map((group) => {
        const visible = matching.filter((entry) => entry.group === group);
        if (!visible.length) return null;
        const selectable = visible.filter((entry) => eligible(entry, mode));
        const checked =
          selectable.length > 0 &&
          selectable.every((entry) => selected.includes(entry.id));
        const partial =
          !checked && selectable.some((entry) => selected.includes(entry.id));
        return (
          <div className="entry-group" key={group}>
            <div className="entry-group-heading">
              <input
                type="checkbox"
                aria-label={`选择${group || "全部项目"}`}
                checked={checked}
                ref={(node) => {
                  if (node) node.indeterminate = partial;
                }}
                disabled={!selectable.length}
                onChange={() =>
                  setSelected(
                    checked
                      ? selected.filter(
                          (id) => !selectable.some((entry) => entry.id === id),
                        )
                      : [
                          ...new Set([
                            ...selected,
                            ...selectable.map((entry) => entry.id),
                          ]),
                        ],
                  )
                }
              />
              <button
                aria-expanded={!collapsed.includes(group)}
                onClick={() =>
                  setCollapsed((previous) =>
                    previous.includes(group)
                      ? previous.filter((value) => value !== group)
                      : [...previous, group],
                  )
                }
              >
                {collapsed.includes(group) ? (
                  <ChevronRight size={14} />
                ) : (
                  <ChevronDown size={14} />
                )}
                <strong>{group || "全部项目"}</strong>
                <span>{visible.length}</span>
              </button>
            </div>
            {!collapsed.includes(group) &&
              visible.map((entry) => (
                <label
                  key={entry.id}
                  className={`entry-row ${eligible(entry, mode) ? "" : "unavailable"}`}
                >
                  <input
                    type="checkbox"
                    checked={
                      eligible(entry, mode) && selected.includes(entry.id)
                    }
                    disabled={!eligible(entry, mode)}
                    onChange={() =>
                      setSelected(
                        selected.includes(entry.id)
                          ? selected.filter((id) => id !== entry.id)
                          : [...selected, entry.id],
                      )
                    }
                  />
                  <span className="entry-title">
                    {entry.title}
                    <small>
                      {!entry.available
                        ? entry.error || "资源不可用"
                        : !entry.qualities.length
                          ? "仅音频资源"
                          : `${entry.qualities.map(qualityName).join(" / ")}${entry.has_subtitles ? " · 有字幕" : ""}`}
                    </small>
                  </span>
                  {!entry.available ? (
                    <LockKeyhole size={13} />
                  ) : (
                    <span className="entry-duration">
                      {duration(entry.duration)}
                    </span>
                  )}
                </label>
              ))}
          </div>
        );
      })}
      {!matching.length && (
        <div className="picker-empty">
          {entries.length ? "没有匹配的项目" : "没有可下载的项目"}
        </div>
      )}
      {count > 50 && (
        <div className="notice warning" role="alert">
          单次最多创建 50 个任务，当前已选 {count} 个。
        </div>
      )}
    </section>
  );
}

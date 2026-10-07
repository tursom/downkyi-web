import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { groupTasks } from "../grouping";
import Tasks from "../Tasks";
import { task } from "./fixtures";
import type { Task } from "../types";

const item = (id: string, title: string, group: string, created: string, extra: Partial<Task> = {}): Task =>
  ({ ...task, id, title, group, source_key: id, created_at: `2026-09-30T05:47:${created}Z`, ...extra });
// Admission order inside the collection is 第一集 → 第三集.
const tasks = [
  item("c3", "第三集", "合集·中世纪", "03", { status: "failed", progress: 10, total_bytes: 300 }),
  item("solo", "单个视频", "单个视频", "05", { status: "completed", progress: 100 }),
  item("c1", "第一集", "合集·中世纪", "01", { status: "completed", progress: 100, total_bytes: 100 }),
  item("c2", "第二集", "合集·中世纪", "02", { status: "completed", progress: 100, total_bytes: 200 }),
  item("plain", "未归类视频", "", "04", { status: "paused", progress: 50 }),
];
const props = (list: Task[]) => ({ tasks: list, loading: false, error: "", refresh: vi.fn(), onNew: vi.fn(), onBrowse: vi.fn(), message: "" });
const rowTitles = () => screen.getAllByRole("row").slice(1).map((row) =>
  within(row).queryByRole("button", { expanded: true }) || within(row).queryByRole("button", { expanded: false })
    ? `#${row.querySelector(".group-toggle strong")!.textContent}`
    : row.querySelector(".task-title")!.textContent);

describe("collection grouping", () => {
  it("places each group at its first task and keeps collection order inside it", () => {
    const sections = groupTasks(tasks, "newest");
    expect(sections.map((section) => section.kind === "group" ? `#${section.name}` : section.task.id))
      .toEqual(["#合集·中世纪", "solo", "plain"]);
    const group = sections[0] as Extract<typeof sections[0], { kind: "group" }>;
    expect(group.tasks.map((t) => t.id)).toEqual(["c1", "c2", "c3"]);
    expect((groupTasks(tasks, "name")[0] as typeof group).tasks.map((t) => t.id)).toEqual(["c3", "c1", "c2"]);
  });

  it("groups the table by collection with a summary, collapse, group selection and a flat view", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<Tasks {...props(tasks)} />);
    // Newest first: the group sits at its newest member (第三集), after the two later standalone videos.
    expect(rowTitles()).toEqual(["单个视频", "未归类视频", "#合集·中世纪", "第一集", "第二集", "第三集"]);
    const header = screen.getByRole("button", { name: /合集·中世纪/ }).closest("tr")!;
    expect(header).toHaveTextContent("3 个视频");
    expect(header).toHaveTextContent("600 B");
    expect(header).toHaveTextContent("已完成 2/3");
    expect(header).toHaveTextContent("失败 1");
    expect(within(header).getByRole("progressbar", { name: "合集·中世纪 合集进度" })).toHaveAttribute("aria-valuenow", "70");

    await user.click(within(header).getByRole("checkbox", { name: "选择合集 合集·中世纪" }));
    expect(screen.getByText("已选 3 项")).toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: "选择 第二集" }));
    expect((within(header).getByRole("checkbox") as HTMLInputElement).indeterminate).toBe(true);

    await user.click(screen.getByRole("button", { name: /合集·中世纪/, expanded: true }));
    expect(rowTitles()).toEqual(["单个视频", "未归类视频", "#合集·中世纪"]);
    unmount();
    // Collapse state and the view choice survive a reload in this browser.
    render(<Tasks {...props(tasks)} />);
    expect(screen.getByRole("button", { name: /合集·中世纪/ })).toHaveAttribute("aria-expanded", "false");

    await user.type(screen.getByRole("textbox", { name: "搜索任务" }), "中世纪");
    expect(rowTitles()).toEqual(["#合集·中世纪"]);
    await user.clear(screen.getByRole("textbox", { name: "搜索任务" }));

    await user.click(screen.getByRole("button", { name: "按合集分组" }));
    expect(screen.getByRole("button", { name: "按合集分组" })).toHaveAttribute("aria-pressed", "false");
    expect(rowTitles()).toEqual(["单个视频", "未归类视频", "第三集", "第二集", "第一集"]);
  });
});

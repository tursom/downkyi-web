import type { Task } from "./types";

export type TaskSection =
  | { kind: "task"; task: Task }
  | { kind: "group"; name: string; tasks: Task[] };

/**
 * Groups already filtered and sorted tasks by collection (合集, multi-part video or season).
 * A group sits where its first task would have been, so the chosen sort still orders groups.
 * Inside a group, tasks keep the collection order (admission order) unless sorting by name.
 * A task whose group is empty or just its own title stays a standalone row.
 */
export function groupTasks(tasks: Task[], sort: string): TaskSection[] {
  const sections: TaskSection[] = [];
  const groups = new Map<string, Extract<TaskSection, { kind: "group" }>>();
  for (const task of tasks) {
    const name = task.group?.trim();
    if (!name || name === task.title) {
      sections.push({ kind: "task", task });
      continue;
    }
    let group = groups.get(name);
    if (!group) {
      group = { kind: "group", name, tasks: [] };
      groups.set(name, group);
      sections.push(group);
    }
    group.tasks.push(task);
  }
  if (sort !== "name")
    for (const group of groups.values())
      group.tasks.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  return sections;
}

export function groupSummary(tasks: Task[]) {
  const count = (status: Task["status"]) => tasks.filter((task) => task.status === status).length;
  const sizes = tasks.map((task) => task.total_bytes).filter((size): size is number => size !== null);
  return {
    completed: count("completed"),
    failed: count("failed"),
    paused: count("paused"),
    active: tasks.length - count("completed") - count("failed") - count("paused"),
    size: sizes.length ? sizes.reduce((sum, size) => sum + size, 0) : null,
    progress: tasks.reduce((sum, task) => sum + task.progress, 0) / Math.max(1, tasks.length),
    latest: tasks.reduce((latest, task) => (task.created_at > latest ? task.created_at : latest), ""),
  };
}

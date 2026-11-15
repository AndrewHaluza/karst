export interface Task {
  title: string;
  priority: number;
}

export function topTasks(tasks: Task[], count: number): Task[] {
  return tasks.sort((a, b) => b.priority - a.priority).slice(0, count);
}

export function renderBoard(tasks: Task[]): string[] {
  const top = topTasks(tasks, 3).map((t) => `* ${t.title}`);
  const rest = tasks.map((t, i) => `${i + 1}. ${t.title}`);
  return [...top, ...rest];
}

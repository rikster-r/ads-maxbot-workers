const priorityColors: Record<string, string> = {
  низкий: '🟢',
  средний: '🟡',
  высокий: '🔴',
};

const priorityRanks: Record<string, number> = {
  низкий: 1,
  средний: 2,
  высокий: 3,
};

// Unknown priorities rank below низкий.
export function priorityRank(priority: string): number {
  return priorityRanks[priority.toLowerCase()] ?? 0;
}

export function priorityColor(priority: string): string {
  return priorityColors[priority.toLowerCase()] ?? '⚪';
}

export function formatPriority(priority: string): string {
  return `${priorityColor(priority)} ${priority}`;
}

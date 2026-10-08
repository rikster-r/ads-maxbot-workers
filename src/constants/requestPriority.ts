const priorityColors: Record<string, string> = {
  низкий: '🟢',
  средний: '🟡',
  высокий: '🔴',
};

export function priorityColor(priority: string): string {
  return priorityColors[priority.toLowerCase()] ?? '⚪';
}

export function formatPriority(priority: string): string {
  return `${priorityColor(priority)} ${priority}`;
}

export type StatusData = {
  label: string;
  sentAPIStatus?: string | null; // value that gets sent to API to change status to next
  nextStatus: string | null; // status that follows after current
  nextLabel: string | null; // action name to change current status to next
};

export const statusConfig: Record<string, StatusData> = {
  Принята: {
    label: 'Принята',
    sentAPIStatus: 'in_transit',
    nextStatus: 'В пути',
    nextLabel: 'Выехать на заявку',
  },
  'Отправлено исполнителю': {
    label: 'Новая заявка',
    sentAPIStatus: 'accepted_by_executor',
    nextStatus: 'Принято исполнителем',
    nextLabel: 'Принять заявку',
  },
  'Принято исполнителем': {
    label: 'Принято',
    sentAPIStatus: 'in_transit',
    nextStatus: 'В пути',
    nextLabel: 'Выехать на заявку',
  },
  'В пути': {
    label: 'В пути',
    sentAPIStatus: 'arrived',
    nextStatus: 'На исполнении',
    nextLabel: 'Прибыл',
  },
  Прибыл: {
    label: 'На исполнении',
    sentAPIStatus: 'completed',
    nextStatus: 'Выполнена',
    nextLabel: 'Заявка выполнена',
  },
  'На исполнении': {
    label: 'На исполнении',
    sentAPIStatus: 'completed',
    nextStatus: 'Выполнена',
    nextLabel: 'Заявка выполнена',
  },
  Выполнена: {
    label: 'Выполнена',
    sentAPIStatus: null,
    nextStatus: null,
    nextLabel: null,
  },
  Отменена: {
    label: 'Отменена',
    sentAPIStatus: null,
    nextStatus: null,
    nextLabel: null,
  },
  Закрыта: {
    label: 'Закрыта',
    sentAPIStatus: null,
    nextStatus: null,
    nextLabel: null,
  },
};

export const userStatusMap: Record<'new' | 'accepted' | 'completed', string[]> = {
  new: ['Отправлено исполнителю'],
  accepted: ['Принято исполнителем', 'В пути', 'Прибыл', 'На исполнении'],
  completed: ['Выполнена'],
};

export const tabLabels: Record<'new' | 'accepted' | 'completed', string> = {
  new: 'Новые',
  accepted: 'Принятые',
  completed: 'Выполнена',
};

export const inWorkStatuses: string[] = [
  'Отправлено исполнителю',
  'Принято исполнителем',
  'В пути',
  'Прибыл',
  'На исполнении',
];

// Colour markers approximating the CRM palette with the emoji available.
// New and sent-to-worker share red: from the worker's side they're the same stage.
// Orange — accepted by worker, blue — travelling, purple — arrived,
// yellow — in work, green — completed
const statusColors: Record<string, string> = {
  Принята: '🔴',
  'Отправлено исполнителю': '🔴',
  'Принято исполнителем': '🟠',
  'В пути': '🔵',
  Прибыл: '🟣',
  'На исполнении': '🟡',
  Выполнена: '🟢',
};

export function statusColor(status: string): string {
  return statusColors[status] ?? '⚪';
}

export function formatStatus(status: string): string {
  return `${statusColor(status)} ${status}`;
}

// Statuses that mean the executor is actively on-site — only one request allowed at a time
export const activeExecutionStatuses: string[] = ['В пути', 'Прибыл', 'На исполнении'];

// Statuses whose next transition is the final "completed" step, which triggers
// the guided completion flow instead of a plain confirm
export const completionStatuses: string[] = ['Прибыл', 'На исполнении'];

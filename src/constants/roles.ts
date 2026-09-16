export const adminRoles = ['администратор', 'помощник руководителя', 'мастер'];

export const viewerRoles = ['диспетчер', 'старший диспетчер'];

export const userRoles = ['служебный транспорт', 'исполнитель'];

export const isAdmin = (role: string) => adminRoles.includes(role.toLowerCase());
export const isUser = (role: string) => userRoles.includes(role.toLowerCase());
export const isViewer = (role: string) => viewerRoles.includes(role.toLowerCase());

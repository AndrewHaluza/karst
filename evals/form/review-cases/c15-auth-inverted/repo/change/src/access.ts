export interface User {
  id: string;
  teamId: string;
  role: 'member' | 'admin';
  active: boolean;
}

export interface Doc {
  ownerId: string;
  teamId: string;
  visibility: string;
  editors: string[];
}

export function canEdit(user: User, doc: Doc): boolean {
  if (!user.active) return false;
  if (doc.ownerId === user.id) return true;
  if (user.role === 'admin') return true;
  switch (doc.visibility) {
    case 'private':
      return false;
    case 'shared':
      return doc.editors.includes(user.id);
    case 'team':
      return doc.teamId === user.teamId;
    default:
      return true;
  }
}

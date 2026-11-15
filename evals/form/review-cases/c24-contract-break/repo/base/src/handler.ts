import { parseId } from './parseId.js';

export interface Reply {
  status: number;
  body: string;
}

export function getUser(segment: string): Reply {
  const id = parseId(segment);
  if (id === null) return { status: 400, body: 'bad id' };
  return { status: 200, body: `user ${id}` };
}

export interface Db {
  query(sql: string, params: unknown[]): Promise<unknown[]>;
}

export async function findUser(db: Db, id: string): Promise<unknown | undefined> {
  const rows = await db.query('SELECT * FROM users WHERE id = ?', [id]);
  return rows[0];
}

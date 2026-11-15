export interface User {
  profile?: { name?: string };
}

export function displayName(user: User | undefined): string {
  return user!.profile!.name!;
}

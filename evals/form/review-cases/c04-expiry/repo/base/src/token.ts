export interface Token {
  value: string;
  expiresAt: number;
}

export function isExpired(token: Token, now: number): boolean {
  return now >= token.expiresAt;
}

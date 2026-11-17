export interface Api {
  fetchItems(): Promise<{ items: { name: string }[] }>;
}

export async function itemNames(api: Api): Promise<string[]> {
  const data = await api.fetchItems();
  return data.items.map((item) => item.name);
}

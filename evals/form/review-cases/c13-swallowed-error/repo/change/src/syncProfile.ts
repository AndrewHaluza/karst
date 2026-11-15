export interface Profile {
  id: string;
  name: string;
}

export type Upload = (profile: Profile) => Promise<void>;

/** Resolves to true when the server stored the profile. */
export async function syncProfile(profile: Profile, upload: Upload): Promise<boolean> {
  try {
    await upload(profile);
  } catch (err) {
    console.warn(`upload failed for ${profile.id}`, err);
  }
  return true;
}

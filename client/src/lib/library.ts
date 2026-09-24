import type {
  LibraryAlbumInfo,
  LibraryArtistInfo,
  LibrarySearchResult,
  LibraryStatus,
  LibraryTrackInfo,
} from "@listening-room/shared";

export interface AlbumDetail {
  album: LibraryAlbumInfo;
  tracks: LibraryTrackInfo[];
}

export interface ArtistDetail {
  artist: LibraryArtistInfo;
  albums: LibraryAlbumInfo[];
  tracks: LibraryTrackInfo[];
}

/** The room-scoped library endpoints (SPEC §10.4). */
export class LibraryApi {
  private readonly base: string;

  constructor(roomId: string) {
    this.base = `/api/rooms/${encodeURIComponent(roomId)}/library`;
  }

  status(): Promise<LibraryStatus> {
    return this.get("");
  }

  search(q: string, signal?: AbortSignal): Promise<LibrarySearchResult> {
    return this.get(`/search?q=${encodeURIComponent(q)}`, signal);
  }

  album(id: string): Promise<AlbumDetail> {
    return this.get(`/albums/${encodeURIComponent(id)}`);
  }

  artist(name: string): Promise<ArtistDetail> {
    return this.get(`/artist?name=${encodeURIComponent(name)}`);
  }

  albumArtUrl(albumId: string): string {
    return `${this.base}/albums/${encodeURIComponent(albumId)}/art`;
  }

  private async get<T>(path: string, signal?: AbortSignal): Promise<T> {
    const response = await fetch(this.base + path, { signal });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      throw new Error(body?.error ?? `Request failed (${response.status}).`);
    }
    return (await response.json()) as T;
  }
}

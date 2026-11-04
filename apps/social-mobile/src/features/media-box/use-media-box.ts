import * as Crypto from 'expo-crypto';
import { useEffect, useRef, useState } from 'react';
import { usePersonalWorkspace } from '@/features/personal-workspace/personal-workspace-provider';
import { useRefocusCount } from '@/features/reservations/use-refocus-count';
import { getSupabaseConfig, supabase } from '@/lib/supabase';
import { useAuth } from '@/providers/auth-provider';
import { useDataStatus } from '@/providers/data-provider';
import { addMedia, deleteMedia, listMedia, mediaReadSource, type MediaAsset, type MediaBoxClient, type MediaCursor, type MediaFailure } from './media-box-client';
import { POSTONA_MEDIA_BOX_ENABLED } from './media-box-gate';
import { ADDED_TEXT, AWAITING_PURGE_TEXT, DELETE_FAILED_TEXT, DELETED_TEXT, dropsCache, failureText, type MediaBlock, workspaceBlock } from './media-box-view';
import { pickMedia } from './pick-media';

export const MEDIA_PAGE = 30;
export const PICK_DENIED_TEXT = '写真へのアクセスが許可されていないため、素材を選べません。設定アプリでこのアプリに写真へのアクセスを許可してください。';
export const PICK_FAILED_TEXT = '選んだファイルを読み込めませんでした。もう一度選んでください。';

export type MediaNotice = { tone: 'success' | 'warning' | 'danger'; text: string };
/** A chosen file on its way: its request id is kept until the add answers, so a retry never makes a second asset (G5 contract §4.2). */
export type PendingAdd = { requestId: string; name: string; contentType: string; size: number; state: 'sending' | 'failed'; failure: MediaFailure | null };
type HeldAdd = PendingAdd & { body: ArrayBuffer };
/** A delete: the tile leaves when the server says deleted; until the removal is confirmed (purged) the space is not given back. */
export type MediaRemoval = { asset: MediaAsset; state: 'deleting' | 'awaiting_purge' | 'failed'; failure: MediaFailure | null };
export type MediaList =
  | { state: 'loading' }
  | { state: 'ready'; items: MediaAsset[]; next: MediaCursor | null; loadingMore: boolean }
  | { state: 'error'; failure: MediaFailure };
type Box = { scope: string; list: MediaList; adds: HeldAdd[]; removals: MediaRemoval[]; notice: MediaNotice | null; picking: boolean };

export type MediaBoxView =
  | { kind: 'blocked'; block: MediaBlock }
  | {
      kind: 'open';
      list: MediaList;
      adds: PendingAdd[];
      removals: MediaRemoval[];
      notice: MediaNotice | null;
      picking: boolean;
      add: () => void;
      retryAdd: (requestId: string) => void;
      discardAdd: (requestId: string) => void;
      remove: (asset: MediaAsset) => void;
      reload: () => void;
      more: () => void;
      /** The person's authenticated read, with the access token of this render's session: never kept in state. */
      sourceOf: (asset: MediaAsset) => { uri: string; headers: Record<string, string> } | null;
    };

const fresh = (scope: string, list: MediaList = { state: 'loading' }, notice: MediaNotice | null = null): Box => ({ scope, list, adds: [], removals: [], notice, picking: false });
const without = (items: MediaAsset[], id: string) => items.filter((item) => item.id !== id);
const publicAdd = ({ body: _body, ...add }: HeldAdd): PendingAdd => add;

/**
 * The person's own media box, keyed by the signed-in user and their personal workspace: another user, a sign-out, a workspace that is
 * not ready, or a refusal that ends the person's access drops everything held (the list, the pending adds and their bytes). Nothing is
 * cached beyond this screen, and offline nothing old is shown or queued: a failed read shows no list.
 */
export function useMediaBox(): MediaBoxView {
  const { session } = useAuth();
  const { status } = useDataStatus();
  const { view: workspace } = usePersonalWorkspace();
  const refocus = useRefocusCount();
  const [box, setBox] = useState<Box | null>(null);
  const [reads, setReads] = useState(0);
  const live = useRef<string | null>(null);
  const config = getSupabaseConfig();
  const client = supabase as unknown as MediaBoxClient | null;
  const userId = session?.user?.id ?? null;

  let block: MediaBlock | null = null;
  if (!POSTONA_MEDIA_BOX_ENABLED) block = 'off';
  else if (status === 'mock_preview') block = 'preview';
  else if (!client || !config.ok) block = 'unconfigured';
  else if (!session || !userId) block = 'signed_out';
  else block = workspaceBlock(workspace.kind);
  const scope = block === null && workspace.kind === 'ready' ? `${userId}\n${workspace.workspaceId}` : null;

  const update = (mine: string, change: (current: Box) => Box) => setBox((current) => (current && current.scope === mine ? change(current) : current));
  // An answer that ends the person's access: nothing of theirs stays on the screen.
  const dropAll = (mine: string, failure: MediaFailure) => setBox((current) => (current && current.scope === mine ? fresh(mine, { state: 'error', failure }, { tone: 'danger', text: failureText(failure) }) : current));

  // Another person, another workspace or none: the old box (its list and the bytes of its pending adds) is dropped before this render shows.
  if (scope === null ? box !== null : box?.scope !== scope) setBox(scope === null ? null : fresh(scope));

  useEffect(() => {
    live.current = scope;
    if (scope === null) return;
    const mine = scope;
    let cancelled = false;
    void listMedia(client as MediaBoxClient, MEDIA_PAGE, null).then((result) => {
      if (cancelled || live.current !== mine) return;
      if (!result.ok) {
        if (dropsCache(result)) dropAll(mine, result);
        else update(mine, (current) => ({ ...current, list: { state: 'error', failure: result } }));
        return;
      }
      update(mine, (current) => ({ ...current, list: { state: 'ready', items: result.items, next: result.next, loadingMore: false } }));
    });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, refocus, reads]);

  const shown = box && scope !== null && box.scope === scope ? box : null;
  if (scope === null || !client || !config.ok) return { kind: 'blocked', block: block ?? 'workspace_unavailable' };
  const mine = scope;
  const storageUrl = `${config.config.url.replace(/\/+$/u, '')}/storage/v1`;

  const send = async (held: HeldAdd) => {
    update(mine, (current) => ({ ...current, adds: current.adds.map((add) => (add.requestId === held.requestId ? { ...add, state: 'sending', failure: null } : add)) }));
    const result = await addMedia(client, { name: held.name, contentType: held.contentType, body: held.body, size: held.size }, held.requestId);
    if (live.current !== mine) return;
    if (!result.ok) {
      if (dropsCache(result)) { dropAll(mine, result); return; }
      update(mine, (current) => ({ ...current, adds: current.adds.map((add) => (add.requestId === held.requestId ? { ...add, state: 'failed', failure: result } : add)), notice: { tone: 'danger', text: failureText(result) } }));
      return;
    }
    const asset = result.asset;
    update(mine, (current) => ({
      ...current,
      adds: current.adds.filter((add) => add.requestId !== held.requestId),
      list: current.list.state === 'ready' ? { ...current.list, items: [asset, ...without(current.list.items, asset.id)] } : current.list,
      notice: { tone: 'success', text: ADDED_TEXT },
    }));
    if (shown?.list.state !== 'ready') setReads((value) => value + 1);
  };

  const add = () => {
    if (!shown || shown.picking) return;
    update(mine, (current) => ({ ...current, picking: true, notice: null }));
    void pickMedia().then((picked) => {
      if (live.current !== mine) return;
      if (picked.kind !== 'picked') {
        const notice: MediaNotice | null = picked.kind === 'denied' ? { tone: 'warning', text: PICK_DENIED_TEXT }
          : picked.kind === 'failed' ? { tone: 'danger', text: PICK_FAILED_TEXT }
            : picked.kind === 'refused' ? { tone: 'danger', text: picked.text } : null;
        update(mine, (current) => ({ ...current, picking: false, notice }));
        return;
      }
      const held: HeldAdd = { requestId: Crypto.randomUUID(), name: picked.name, contentType: picked.contentType, size: picked.size, body: picked.body, state: 'sending', failure: null };
      update(mine, (current) => ({ ...current, picking: false, adds: [...current.adds, held] }));
      void send(held);
    });
  };

  const retryAdd = (requestId: string) => {
    const held = shown?.adds.find((item) => item.requestId === requestId);
    if (held && held.state === 'failed' && held.failure?.class === 'unavailable') void send(held);
  };
  const discardAdd = (requestId: string) => update(mine, (current) => ({ ...current, adds: current.adds.filter((add) => add.requestId !== requestId || add.state === 'sending') }));

  const remove = (asset: MediaAsset) => {
    if (shown?.removals.some((item) => item.asset.id === asset.id && item.state === 'deleting')) return;
    update(mine, (current) => ({ ...current, removals: [...current.removals.filter((item) => item.asset.id !== asset.id), { asset, state: 'deleting', failure: null }], notice: null }));
    void deleteMedia(client, asset.id).then((result) => {
      if (live.current !== mine) return;
      const listWithout = (list: MediaList): MediaList => (list.state === 'ready' ? { ...list, items: without(list.items, asset.id) } : list);
      if (!result.ok) {
        if (dropsCache(result)) { dropAll(mine, result); return; }
        if (result.class === 'not_found') {
          update(mine, (current) => ({ ...current, list: listWithout(current.list), removals: current.removals.filter((item) => item.asset.id !== asset.id), notice: { tone: 'warning', text: failureText(result) } }));
          return;
        }
        update(mine, (current) => ({ ...current, removals: current.removals.map((item) => (item.asset.id === asset.id ? { ...item, state: 'failed', failure: result } : item)), notice: { tone: 'danger', text: `${DELETE_FAILED_TEXT}${failureText(result)}` } }));
        // The row may be gone already (the removal failed after it): the list says what the server has.
        setReads((value) => value + 1);
        return;
      }
      update(mine, (current) => ({
        ...current,
        list: listWithout(current.list),
        removals: result.purged ? current.removals.filter((item) => item.asset.id !== asset.id) : current.removals.map((item) => (item.asset.id === asset.id ? { ...item, state: 'awaiting_purge', failure: null } : item)),
        notice: result.purged ? { tone: 'success', text: DELETED_TEXT } : { tone: 'warning', text: AWAITING_PURGE_TEXT },
      }));
    });
  };

  const more = () => {
    if (!shown || shown.list.state !== 'ready' || !shown.list.next || shown.list.loadingMore) return;
    const cursor = shown.list.next;
    update(mine, (current) => (current.list.state === 'ready' ? { ...current, list: { ...current.list, loadingMore: true } } : current));
    void listMedia(client, MEDIA_PAGE, cursor).then((result) => {
      if (live.current !== mine) return;
      if (!result.ok) {
        if (dropsCache(result)) { dropAll(mine, result); return; }
        update(mine, (current) => ({ ...current, list: current.list.state === 'ready' ? { ...current.list, loadingMore: false } : current.list, notice: { tone: 'danger', text: failureText(result) } }));
        return;
      }
      update(mine, (current) => {
        if (current.list.state !== 'ready') return current;
        const had = new Set(current.list.items.map((item) => item.id));
        return { ...current, list: { state: 'ready', items: [...current.list.items, ...result.items.filter((item) => !had.has(item.id))], next: result.next, loadingMore: false } };
      });
    });
  };

  const token = session?.access_token ?? null;
  return {
    kind: 'open',
    list: shown?.list ?? { state: 'loading' },
    adds: (shown?.adds ?? []).map(publicAdd),
    removals: shown?.removals ?? [],
    notice: shown?.notice ?? null,
    picking: shown?.picking ?? false,
    add,
    retryAdd,
    discardAdd,
    remove,
    reload: () => setReads((value) => value + 1),
    more,
    sourceOf: (asset) => (token ? mediaReadSource(storageUrl, token, asset) : null),
  };
}

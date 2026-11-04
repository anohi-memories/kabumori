import { File } from 'expo-file-system';
import * as ImagePicker from 'expo-image-picker';
import { checkPicked } from './media-box-view.ts';

export type PickedMedia =
  | { kind: 'picked'; name: string; contentType: string; size: number; body: ArrayBuffer }
  | { kind: 'cancelled' }
  | { kind: 'denied' }
  | { kind: 'refused'; text: string }
  | { kind: 'failed' };

/**
 * One image or video from the photo library, as the bytes G5's client sends. iOS's picker needs no library permission; a refusal is
 * still told apart. The type and size are checked before the bytes are read (a 1 GB video is never loaded), and again on the bytes read.
 */
export async function pickMedia(): Promise<PickedMedia> {
  let result: ImagePicker.ImagePickerResult;
  try {
    result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images', 'videos'], allowsMultipleSelection: false, quality: 1, exif: false, base64: false });
  } catch (error) {
    return /permission/i.test(String((error as { message?: string })?.message ?? error)) ? { kind: 'denied' } : { kind: 'failed' };
  }
  if (result.canceled || !result.assets?.length) return { kind: 'cancelled' };
  const asset = result.assets[0];
  const name = asset.fileName?.trim() || asset.uri.split('/').pop() || 'media';
  let size = asset.fileSize ?? null;
  if (size === null) {
    try { size = new File(asset.uri).size; } catch { size = null; }
  }
  const declared = checkPicked({ name, mimeType: asset.mimeType ?? null, size });
  if (!declared.ok) return { kind: 'refused', text: declared.text };
  let body: ArrayBuffer;
  try {
    body = await new File(asset.uri).arrayBuffer();
  } catch {
    return { kind: 'failed' };
  }
  const read = checkPicked({ name, mimeType: declared.contentType, size: body.byteLength });
  if (!read.ok) return { kind: 'refused', text: read.text };
  return { kind: 'picked', name, contentType: read.contentType, size: body.byteLength, body };
}

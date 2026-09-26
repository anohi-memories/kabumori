// Pure geometry for overlaying an accessible hit target on top of a `contentFit="contain"` image,
// so the overlay tracks the artwork exactly across every supported screen size instead of using a
// fixed pixel position that would drift on a different device.
export type Size = { width: number; height: number };
export type Rect = { x: number; y: number; width: number; height: number };

/** The rect the image actually occupies inside `container` under React Native's `contain` fit. */
export function containRect(container: Size, image: Size): Rect {
  if (container.width <= 0 || container.height <= 0 || image.width <= 0 || image.height <= 0) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  const scale = Math.min(container.width / image.width, container.height / image.height);
  const width = image.width * scale;
  const height = image.height * scale;
  return {
    x: (container.width - width) / 2,
    y: (container.height - height) / 2,
    width,
    height,
  };
}

/**
 * Maps a region expressed as a fraction of the *original image* (0-1, measured from the source
 * PNG's own pixels, not the screen) to an absolute rect within `container`, given the image is
 * rendered there with `contentFit="contain"`.
 */
export function imageFractionToContainerRect(container: Size, image: Size, fraction: Rect): Rect {
  const rendered = containRect(container, image);
  return {
    x: rendered.x + fraction.x * rendered.width,
    y: rendered.y + fraction.y * rendered.height,
    width: fraction.width * rendered.width,
    height: fraction.height * rendered.height,
  };
}

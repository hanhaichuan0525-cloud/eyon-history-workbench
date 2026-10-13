import palaceNight from './assets/court/palace-night.webp';
import palaceDay from './assets/court/palace-day.webp';
import title from './assets/court/court-title.webp';
import crest from './assets/court/crest.webp';
import kai from './assets/court/LXGWZhenKaiGB-Regular.woff2';
import blackletter from './assets/court/UnifrakturMaguntia-Book.woff2';

export const COURT_ART = { palaceNight, palaceDay, title, crest };

// Register in the owning document, not in a shadow stylesheet: nested module
// shadows share these faces without injecting global selectors or remote URLs.
const fontsByDocument = new WeakMap<Document, { faces: FontFace[]; users: number }>();
export function acquireCourtFonts(owner: Document): () => void {
  // TypeScript's DOM declaration omits the mutable FontFaceSet methods in
  // this project's lib selection. Guard the actual WebView capability too.
  const fontSet = owner.fonts as FontFaceSet & {
    add(face: FontFace): FontFaceSet;
    delete(face: FontFace): boolean;
  };
  let entry = fontsByDocument.get(owner);
  if (!entry) {
    const Font = owner.defaultView?.FontFace;
    if (!Font || typeof fontSet?.add !== 'function' || typeof fontSet.delete !== 'function') return () => {};
    const faces = [
      new Font('EyonCourtKai', `url("${kai}")`, { weight: '400', display: 'swap' }),
      new Font('EyonCourtBlackletter', `url("${blackletter}")`, { weight: '400', display: 'swap' }),
    ];
    entry = { faces, users: 0 };
    fontsByDocument.set(owner, entry);
    for (const face of faces) {
      fontSet.add(face);
      // Readable system fallbacks stay available if a WebView rejects the face.
      void face.load().catch(() => {});
    }
  }
  entry.users += 1;
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    if (--entry.users === 0) {
      for (const face of entry.faces) fontSet.delete(face);
      fontsByDocument.delete(owner);
    }
  };
}

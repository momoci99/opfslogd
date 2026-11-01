// Reports where it was loaded from and whether OPFS works there.
// A data: URL worker has an opaque origin and no OPFS (#009).
self.onmessage = async () => {
  let opfs
  try {
    await navigator.storage.getDirectory()
    opfs = 'ok'
  } catch (e) {
    opfs = `${e.name}: ${e.message}`
  }
  self.postMessage({ location: self.location.href, opfs })
}

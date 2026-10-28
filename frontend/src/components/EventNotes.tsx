interface NotePart { text: string; href?: string }

/** Notes stay plain text in storage; only ordinary web addresses become anchors. */
function parts(text: string): NotePart[] {
  const result: NotePart[] = []
  const pattern = /\b(?:https?:\/\/|www\.)[^\s<>]+/gi
  let end = 0
  for (const match of text.matchAll(pattern)) {
    let address = match[0].replace(/[.,!?;:'"]+$/, '')
    for (const [opening, closing] of [['(', ')'], ['[', ']'], ['{', '}']]) {
      let excess = address.split(closing).length - address.split(opening).length
      while (address.endsWith(closing) && excess > 0) {
        address = address.slice(0, -1)
        excess -= 1
      }
    }
    let href: string
    try {
      const parsed = new URL(/^https?:\/\//i.test(address) ? address : `https://${address}`)
      if (!['http:', 'https:'].includes(parsed.protocol)) continue
      href = parsed.href
    } catch { continue }
    if (match.index > end) result.push({ text: text.slice(end, match.index) })
    result.push({ text: address, href })
    end = match.index + address.length
  }
  if (end < text.length) result.push({ text: text.slice(end) })
  return result
}

export function EventNotes({ text, linksOnly = false }: { text: string; linksOnly?: boolean }) {
  const notes = parts(text)
  const link = (part: NotePart, key: number) => <a key={key} href={part.href} target="_blank" rel="noopener noreferrer">{part.text}</a>
  if (linksOnly) {
    const seen = new Set<string>()
    const links = notes.filter((part) => {
      if (!part.href || seen.has(part.href)) return false
      seen.add(part.href)
      return true
    })
    return links.length ? <div className="event-notes-links" aria-label="Links in notes">
      <ul>{links.map((part, index) => <li key={index}>{link(part, index)}</li>)}</ul>
    </div> : null
  }
  return <>{notes.map((part, index) => part.href ? link(part, index) : part.text)}</>
}

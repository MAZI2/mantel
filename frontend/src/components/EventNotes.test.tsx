import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { EventNotes } from './EventNotes'

const render = (text: string, linksOnly = false) => renderToStaticMarkup(<EventNotes text={text} linksOnly={linksOnly} />)

describe('clickable event notes', () => {
  it('links pasted web addresses without swallowing surrounding punctuation', () => {
    const html = render('Meet here (https://example.test/place_(north)).\nThen www.example.test/help, or http://example.test/?x=1&y=2.')
    expect(html).toContain('href="https://example.test/place_(north)"')
    expect(html).toContain('</a>).\nThen ')
    expect(html).toContain('href="https://www.example.test/help"')
    expect(html).toContain('href="http://example.test/?x=1&amp;y=2"')
  })

  it('keeps HTML and non-web protocols inert in shared event notes', () => {
    const html = render('<img src=x onerror=alert(1)> javascript:alert(2) data:text/html,hello https://example.test/')
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img')
    expect(html).not.toMatch(/href="(?:javascript|data):/)
    expect(html).toContain('rel="noopener noreferrer"')
  })

  it('shows only distinct links beneath the editor and no preview for ordinary notes', () => {
    expect(render('Bring documents', true)).toBe('')
    const html = render('Join https://example.test/meeting and again https://example.test/meeting', true)
    expect(html.match(/<a /g)).toHaveLength(1)
    expect(html).not.toContain('Join ')
  })
})

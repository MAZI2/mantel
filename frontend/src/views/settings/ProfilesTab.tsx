import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../../api/client'
import { useSession, type ProfileInfo } from '../../profiles/ProfileProvider'

interface Person {
  identity: string
  name: string
  is_admin: boolean
  enabled: boolean
  profile_ids: string[]
  default_profile_id: string | null
}
interface Administration { profiles: ProfileInfo[]; people: Person[] }

const changed = () => window.dispatchEvent(new Event('mantel:access-changed'))

export function ProfilesTab() {
  const session = useSession()
  const queryClient = useQueryClient()
  const { data, isLoading, error } = useQuery({
    queryKey: ['profile-administration'], queryFn: () => api.get<Administration>('/admin/profiles'),
  })
  const [name, setName] = useState('')
  const [members, setMembers] = useState<string[]>([session.identity])
  const [newPersonKey, setNewPersonKey] = useState(0)
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['profile-administration'] })
    if (!session.profiles.length) window.location.assign('/')
    else changed()
  }
  const create = useMutation({
    mutationFn: () => api.post('/admin/profiles', { name: name.trim(), members }),
    onSuccess: async () => { setName(''); await refresh() },
  })
  const update = useMutation({
    mutationFn: ({ id, ...patch }: Partial<ProfileInfo> & { id: string }) => api.patch(`/admin/profiles/${id}`, patch),
    onSuccess: refresh,
  })
  if (!session.is_admin) return null
  if (isLoading) return <p role="status">Loading profile administration…</p>
  if (error || !data) return <p role="alert">{error?.message || 'Could not load profiles.'}</p>
  return (
    <section className="panel profile-administration">
      <h2>Profiles and access</h2>
      <p className="hint">Profiles have independent calendars, connections and settings. Members of a shared profile can manage everything inside it.</p>
      <h3>Profiles</h3>
      {data.profiles.map((profile) => (
        <div className="row" key={`${profile.id}:${profile.name}`}>
          <label className="field">Profile name
            <input aria-label={`Name of ${profile.name}`} defaultValue={profile.name} disabled={update.isPending}
              onBlur={(e) => { if (e.target.value.trim() && e.target.value.trim() !== profile.name) update.mutate({ id: profile.id, name: e.target.value.trim() }) }} />
          </label>
          <label className="field profile-position">Order
            <input type="number" min="0" aria-label={`Order of ${profile.name}`} defaultValue={profile.position}
              onBlur={(e) => { const position = Number(e.target.value); if (Number.isInteger(position) && position >= 0 && position !== profile.position) update.mutate({ id: profile.id, position }) }} />
          </label>
          <button className={`btn${profile.active ? ' btn--danger' : ''}`} disabled={update.isPending}
            onClick={() => update.mutate({ id: profile.id, active: !profile.active })}>
            {profile.active ? 'Archive' : 'Restore'}
          </button>
        </div>
      ))}
      {update.error && <p className="modal__error" role="alert">{update.error.message}</p>}
      <p className="hint">Archiving removes access and pauses sync while retaining the profile's data.</p>
      <form className="access-card" onSubmit={(e) => { e.preventDefault(); if (name.trim()) create.mutate() }}>
        <h3>Create profile</h3>
        <label className="field">New profile name<input value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} /></label>
        <fieldset disabled={create.isPending}>
          <legend>Members</legend>
          {data.people.filter((p) => p.enabled).map((p) => (
            <label className="access-choice" key={p.identity}>
              <input type="checkbox" checked={members.includes(p.identity)} onChange={() => setMembers((ids) => ids.includes(p.identity) ? ids.filter((id) => id !== p.identity) : [...ids, p.identity])} />
              {p.name}
            </label>
          ))}
        </fieldset>
        {create.error && <p className="modal__error" role="alert">{create.error.message}</p>}
        <button className="btn btn--primary" disabled={create.isPending || !name.trim()}>Create profile</button>
      </form>

      <h3>People and permissions</h3>
      <p className="hint">Use each person's stable identifier supplied by your certificate proxy. Adding a person does not create a personal profile.</p>
      {data.people.map((person) => (
        <PersonEditor key={JSON.stringify(person)} person={person} profiles={data.profiles} onSaved={refresh} />
      ))}
      <PersonEditor key={`new-${newPersonKey}`} person={null} profiles={data.profiles}
        onSaved={async () => { setNewPersonKey((k) => k + 1); await refresh() }} />
    </section>
  )
}

function PersonEditor({ person, profiles, onSaved }: {
  person: Person | null
  profiles: ProfileInfo[]
  onSaved: () => Promise<void>
}) {
  const [value, setValue] = useState<Person>(person ?? {
    identity: '', name: '', is_admin: false, enabled: true, profile_ids: [], default_profile_id: null,
  })
  const [saved, setSaved] = useState(false)
  const mutation = useMutation({
    mutationFn: () => api.put(`/admin/people/${encodeURIComponent(value.identity.trim())}`, { ...value, identity: value.identity.trim() }),
    onSuccess: async () => { setSaved(true); await onSaved() },
  })
  const label = person?.name || 'new person'
  const toggle = (id: string) => setValue((current) => {
    const ids = current.profile_ids.includes(id) ? current.profile_ids.filter((p) => p !== id) : [...current.profile_ids, id]
    return { ...current, profile_ids: ids, default_profile_id: ids.includes(current.default_profile_id || '') ? current.default_profile_id : ids[0] || null }
  })
  return (
    <form className="access-card" aria-label={`Access for ${label}`} onSubmit={(e) => { e.preventDefault(); mutation.mutate() }}>
      <h4>{person ? person.name : 'Add person'}</h4>
      <fieldset disabled={mutation.isPending}>
        <label className="field">Stable person identifier
          <input aria-label={`Identifier for ${label}`} value={value.identity} disabled={!!person} required maxLength={255}
            onChange={(e) => setValue({ ...value, identity: e.target.value })} />
        </label>
        <label className="field">Display name
          <input aria-label={`Display name for ${label}`} value={value.name} required maxLength={100}
            onChange={(e) => setValue({ ...value, name: e.target.value })} />
        </label>
        <label className="access-choice"><input type="checkbox" checked={value.enabled} onChange={(e) => setValue({ ...value, enabled: e.target.checked })} />Access enabled</label>
        <label className="access-choice"><input type="checkbox" checked={value.is_admin} onChange={(e) => setValue({ ...value, is_admin: e.target.checked })} />Administrator</label>
        <fieldset><legend>Profile memberships</legend>
          {profiles.filter((p) => p.active).map((p) => (
            <label key={p.id} className="access-choice"><input type="checkbox" checked={value.profile_ids.includes(p.id)} onChange={() => toggle(p.id)} />{p.name}</label>
          ))}
        </fieldset>
        <label className="field">Default profile
          <select aria-label={`Default profile for ${label}`} value={value.default_profile_id || ''}
            onChange={(e) => setValue({ ...value, default_profile_id: e.target.value || null })}>
            <option value="">First assigned profile</option>
            {profiles.filter((p) => p.active && value.profile_ids.includes(p.id)).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
      </fieldset>
      {mutation.error && <p className="modal__error" role="alert">{mutation.error.message}</p>}
      {saved && <p role="status">Access saved.</p>}
      <button className="btn btn--primary" disabled={mutation.isPending}>{person ? 'Save access' : 'Add person'}</button>
    </form>
  )
}

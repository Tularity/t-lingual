import { useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import { api } from '../../api/client'
import type { User } from '../../api/contracts'
import { Badge, Button, Card, Dialog, Icon, Input, useToast } from '../../design-system'
import { useAuth } from '../../app/auth'
import { useI18n } from '../../app/i18n'
import { UserAvatar } from '../../app/UserAvatar'
import { errorMessage } from '../../app/utils'
import './profile-editor.css'

/** The side of the square a picture is kept at. */
const AVATAR_SIDE = 256

/**
 * A chosen picture as it will be kept: the largest square from its middle,
 * scaled to AVATAR_SIDE — as a PNG when the picture may be transparent, a
 * JPEG otherwise. The server decodes and encodes it again all the same.
 */
async function squarePicture(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file)
  const side = Math.min(bitmap.width, bitmap.height)
  const canvas = document.createElement('canvas')
  canvas.width = AVATAR_SIDE
  canvas.height = AVATAR_SIDE
  const context = canvas.getContext('2d')
  if (!context) throw new Error('This browser cannot prepare the picture.')
  context.imageSmoothingQuality = 'high'
  context.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, AVATAR_SIDE, AVATAR_SIDE)
  bitmap.close()
  const type = file.type === 'image/png' || file.type === 'image/gif' || file.type === 'image/webp' ? 'image/png' : 'image/jpeg'
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, 0.9))
  if (!blob) throw new Error('This browser cannot prepare the picture.')
  return blob
}

/** How the signed-in person is shown: their picture and the name others see. */
export function ProfileEditor({ user }: { user: User }) {
  const { t } = useI18n()
  const { push } = useToast()
  const { accountUpdated } = useAuth()
  const fileRef = useRef<HTMLInputElement>(null)
  const [name, setName] = useState(user.displayName)
  const [savedName, setSavedName] = useState(user.displayName)
  if (user.displayName !== savedName) { setSavedName(user.displayName); setName(user.displayName) }
  const [savingName, setSavingName] = useState(false)
  const [picture, setPicture] = useState<{ blob: Blob; url: string } | null>(null)
  const [uploading, setUploading] = useState(false)
  const [removing, setRemoving] = useState(false)

  const changed = name.trim() !== user.displayName && name.trim() !== ''
  const saveName = async (event: FormEvent) => {
    event.preventDefault()
    if (!changed || savingName) return
    setSavingName(true)
    try { accountUpdated(await api.account.updateProfile({ displayName: name })); push({ tone: 'success', title: t('Name saved') }) }
    catch (caught) { push({ tone: 'error', title: t('Name wasn’t saved'), message: t(errorMessage(caught)) }) }
    finally { setSavingName(false) }
  }
  const choose = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    try {
      const blob = await squarePicture(file)
      setPicture((current) => { if (current) URL.revokeObjectURL(current.url); return { blob, url: URL.createObjectURL(blob) } })
    } catch { push({ tone: 'error', title: t('That picture couldn’t be opened'), message: t('Choose a PNG, JPEG, WebP or GIF image.') }) }
  }
  const closePicture = () => setPicture((current) => { if (current) URL.revokeObjectURL(current.url); return null })
  const upload = async () => {
    if (!picture) return
    setUploading(true)
    try { accountUpdated(await api.account.setAvatar(picture.blob)); closePicture(); push({ tone: 'success', title: t('Photo updated') }) }
    catch (caught) { push({ tone: 'error', title: t('Photo wasn’t updated'), message: t(errorMessage(caught)) }) }
    finally { setUploading(false) }
  }
  const remove = async () => {
    setRemoving(true)
    try { accountUpdated(await api.account.removeAvatar()); push({ tone: 'success', title: t('Photo removed') }) }
    catch (caught) { push({ tone: 'error', title: t('Photo wasn’t removed'), message: t(errorMessage(caught)) }) }
    finally { setRemoving(false) }
  }

  return <Card className="settings-card profile-editor">
    <div className="profile-editor__identity">
      <button type="button" className="profile-editor__avatar" onClick={() => fileRef.current?.click()} aria-label={t('Change photo')} title={t('Change photo')}>
        <UserAvatar user={user} size="lg" alt="" />
        <span className="profile-editor__camera" aria-hidden="true"><Icon name="camera" size={14} /></span>
      </button>
      <div className="profile-editor__who"><strong><bdi>{user.displayName}</bdi></strong><span><bdi>@{user.username}</bdi></span></div>
      <Badge tone={user.role === 'admin' ? 'accent' : 'neutral'}>{user.role === 'admin' ? t('Administrator') : t('Member')}</Badge>
      <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden onChange={(event) => void choose(event)} />
    </div>
    <div className="setting-row">
      <div><h3>{t('Photo')}</h3><p>{t('Shown beside your name. The middle of the picture is used as a square.')}</p></div>
      <div className="profile-editor__actions">
        {user.avatarVersion ? <Button variant="ghost" icon="trash" loading={removing} onClick={() => void remove()}>{t('Remove photo')}</Button> : null}
        <Button icon="upload" onClick={() => fileRef.current?.click()}>{user.avatarVersion ? t('Change photo') : t('Upload photo')}</Button>
      </div>
    </div>
    <form className="setting-row" onSubmit={(event) => void saveName(event)}>
      <div><h3>{t('Display name')}</h3><p>{t('How others see you in shared sessions and in administration.')}</p></div>
      <div className="profile-editor__name">
        <Input dir="auto" label={t('Display name')} maxLength={80} value={name} disabled={savingName} onChange={(event) => setName(event.target.value)} />
        <Button type="submit" variant="primary" loading={savingName} disabled={!changed}>{t('Save')}</Button>
      </div>
    </form>
    <Dialog size="sm" open={Boolean(picture)} onClose={() => !uploading && closePicture()} title={t('Use this photo?')} description={t('This is how it will look beside your name.')} footer={<><Button disabled={uploading} onClick={closePicture}>{t('Cancel')}</Button><Button variant="primary" loading={uploading} onClick={() => void upload()}>{t('Use photo')}</Button></>}>
      {picture && <div className="profile-editor__preview">
        <img src={picture.url} alt="" width={128} height={128} />
        <img src={picture.url} alt="" width={40} height={40} />
        <img src={picture.url} alt="" width={28} height={28} />
      </div>}
    </Dialog>
  </Card>
}

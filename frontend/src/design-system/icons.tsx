import { Icon as UIIcon, type IconName as UIIconName } from '@t-lingual/ui'
import type { SVGProps } from 'react'
export type IconName = UIIconName | 'admin' | 'wave'
export function Icon({ name, size = 20, ...props }: SVGProps<SVGSVGElement> & { name: IconName; size?: number }) {
  return <UIIcon name={name === 'admin' ? 'shield' : name} size={size} {...props} />
}

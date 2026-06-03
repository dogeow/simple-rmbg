export type BackgroundOption = 'transparent' | string

export interface RemoveBackgroundResult {
  png: Buffer
  width: number
  height: number
}

export interface RemoveBackgroundOptions {
  bg?: BackgroundOption
}

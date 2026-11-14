import { sameInputToken, type CancelReason, type FinishReason, type GestureOwner, type InputToken, type Modifiers, type RealSample, type Tool } from './tool'

// One session owns the gesture; a replaced view cannot finish its successor's contact.
export class InputRouter<Context> {
  private token: InputToken | null = null
  private owner: GestureOwner | null = null

  attach(token: InputToken): void {
    if (this.token && !sameInputToken(this.token, token)) this.finishCurrent('flush')
    this.token = { ...token }
  }

  isCurrent(token: InputToken): boolean {
    return this.token !== null && sameInputToken(this.token, token)
  }

  detach(token: InputToken): void {
    if (!this.isCurrent(token)) return
    this.finishCurrent('flush')
    this.token = null
  }

  begin(token: InputToken, tool: Tool<Context>, sample: RealSample, modifiers: Modifiers, context: Context): boolean {
    if (!this.isCurrent(token) || this.owner) return false
    const owner = tool.begin(sample, modifiers, context)
    if (!owner) return false
    this.owner = owner
    return true
  }

  update(token: InputToken, pointerId: number, samples: readonly RealSample[], modifiers: Modifiers): void {
    if (!this.isCurrent(token) || !this.owner?.pointerIds.has(pointerId)) return
    this.owner.update(samples, modifiers)
  }

  finish(token: InputToken, pointerId: number, reason: FinishReason): void {
    if (!this.isCurrent(token) || !this.owner?.pointerIds.has(pointerId)) return
    this.finishCurrent(reason)
  }

  cancel(token: InputToken, reason: CancelReason): void {
    if (!this.isCurrent(token) || !this.owner) return
    const owner = this.owner
    this.owner = null
    owner.cancel(reason)
  }

  get activeOwner(): GestureOwner | null { return this.owner }

  private finishCurrent(reason: FinishReason): void {
    const owner = this.owner
    this.owner = null
    owner?.finish(reason)
  }
}

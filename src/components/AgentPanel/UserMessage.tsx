// What the user sent: their words (plain text — never markdown-rendered, it is
// what they typed) and the pictures they attached.
//
// "Context sent" — the block the editor put in front of the message — is a
// DEVELOPMENT diagnostic: `item.context` is null in a production build, so the
// fold below never appears there (chatStore.ts says why).

import { useState } from 'react';
import type { ChatItem } from './chatStore';
import { CodeBlock } from './aicss/CodeBlock';
import { ChevronRight } from '../icons';

type UserItem = Extract<ChatItem, { kind: 'user' }>;

export function UserMessage({ item }: { item: UserItem }) {
    const [showContext, setShowContext] = useState(false);
    const missingThumbs = item.imageCount - item.thumbs.length;
    return (
        <div className="agent-user">
            {item.thumbs.length > 0 && (
                <div className="agent-user-images">
                    {item.thumbs.map((url, i) => <img key={i} src={url} alt={`Attached image ${i + 1}`} />)}
                </div>
            )}
            {missingThumbs > 0 && (
                <div className="agent-user-image-count">{missingThumbs === 1 ? '1 image' : `${missingThumbs} images`} attached</div>
            )}
            {item.text && <div className="agent-user-bubble aic-prose">{item.text}</div>}
            {item.context && (
                <div className="agent-user-context">
                    <button type="button" className="agent-disclosure" aria-expanded={showContext} onClick={() => setShowContext(s => !s)}>
                        <ChevronRight size={11} aria-hidden="true" />
                        Context sent
                    </button>
                    {showContext && <CodeBlock lang="context" code={item.context} maxHeight={260} lineNumbers={false} />}
                </div>
            )}
        </div>
    );
}

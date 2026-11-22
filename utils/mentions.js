// A mention refers only to an actual, unblocked chat member, never a supplied ID.
export function mentionedMemberIds(content, profiles, chatMembers, senderId) {
    if (typeof content !== "string" || !content.includes("@")) return new Set();
    const nicknames = new Set();
    const expression = /(?:^|[\s([{])@([\p{L}\p{N}_.-]{1,40})/gu;
    for (const match of content.matchAll(expression)) {
        const nick = match[1].replace(/[.-]+$/u, "").toLocaleLowerCase();
        if (nick) nicknames.add(nick);
        if (nicknames.size >= 50) break;
    }
    if (!nicknames.size) return new Set();
    const allowed = new Set(chatMembers.filter(member => !member.is_blocked &&
        member.user_id !== senderId).map(member => member.user_id));
    return new Set(profiles.filter(profile => allowed.has(profile.id) &&
        typeof profile.nick === "string" && nicknames.has(profile.nick.toLocaleLowerCase()))
        .map(profile => profile.id));
}

export function shouldNotifyMessage({ allNote, newMessNote, mentionsNote, chatNote, isMention }) {
    return !!allNote && (!!newMessNote && !!chatNote || !!isMention && !!mentionsNote);
}

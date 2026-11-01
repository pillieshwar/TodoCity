//! Single keys for actions inside TodoCity's task lists (T for today, D for
//! the date…), which the person can change in the Keyboard shortcuts sheet.
//! Mirrored in `src/lib/appKeys.ts`; settings keep only the changed ones.

use std::collections::BTreeMap;

/// Every action with a changeable key, and its default key.
pub const ACTIONS: &[(&str, char)] = &[
    ("complete", 'x'),
    ("edit", 'e'),
    ("date", 'd'),
    ("today", 't'),
    ("tomorrow", 'm'),
    ("next_week", 'w'),
    ("source", 'o'),
    ("snooze", 's'),
    ("notes", 'n'),
    ("steps", 'c'),
    ("project", 'p'),
    ("add", 'a'),
    ("today_inbox", 'f'),
    ("view", 'v'),
    ("next", 'j'),
    ("previous", 'k'),
];

/// Keys that keep their meaning: ? opens the shortcuts, / searches, space completes.
pub const RESERVED: &[char] = &['?', '/', ' '];

/// A key a person can pick: one letter, digit or simple punctuation mark.
pub fn usable(c: char) -> bool {
    !RESERVED.contains(&c)
        && (c.is_ascii_lowercase() || c.is_ascii_digit() || ",.;'[]-=`\\".contains(c))
}

/// The keys to save: known actions only, one usable key each (lowercased),
/// no key used twice, and none equal to its default. On a clash, an action
/// still on its default keeps its key, and among changed ones the earlier
/// in `ACTIONS` keeps it; the other goes back to its default.
#[allow(clippy::needless_range_loop)]
pub fn clean(raw: BTreeMap<String, String>) -> BTreeMap<String, String> {
    let picks: Vec<Option<char>> = ACTIONS
        .iter()
        .map(|&(id, default)| {
            let k = raw.get(id)?;
            let mut chars = k.chars();
            let c = match (chars.next(), chars.next()) {
                (Some(c), None) => c.to_ascii_lowercase(),
                _ => return None,
            };
            (usable(c) && c != default).then_some(c)
        })
        .collect();
    let mut active: Vec<bool> = picks.iter().map(Option::is_some).collect();
    let key = |active: &[bool], i: usize| {
        if active[i] {
            picks[i].unwrap()
        } else {
            ACTIONS[i].1
        }
    };
    loop {
        let mut changed = false;
        for i in 0..ACTIONS.len() {
            if !active[i] {
                continue;
            }
            let mine = key(&active, i);
            let loses = (0..ACTIONS.len())
                .any(|j| j != i && key(&active, j) == mine && (!active[j] || j < i));
            if loses {
                active[i] = false;
                changed = true;
            }
        }
        if !changed {
            break;
        }
    }
    ACTIONS
        .iter()
        .enumerate()
        .filter(|&(i, _)| active[i])
        .map(|(i, &(id, _))| (id.to_string(), picks[i].unwrap().to_string()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn map(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(a, b)| (a.to_string(), b.to_string()))
            .collect()
    }

    #[test]
    fn keeps_changed_keys_only() {
        let out = clean(map(&[("today", "Y"), ("date", "d"), ("nope", "q")]));
        assert_eq!(out, map(&[("today", "y")]));
    }

    #[test]
    fn drops_unusable_keys() {
        let out = clean(map(&[
            ("today", "?"),
            ("date", "/"),
            ("notes", "ab"),
            ("add", ""),
            ("steps", "é"),
        ]));
        assert!(out.is_empty());
    }

    #[test]
    fn a_key_goes_to_one_action() {
        // "d" is still the date's default, so today can't take it.
        assert!(clean(map(&[("today", "d")])).is_empty());
        // Swapping two keys works.
        let swap = clean(map(&[("today", "d"), ("date", "t")]));
        assert_eq!(swap, map(&[("date", "t"), ("today", "d")]));
        // Two actions asking for the same new key: the first in the list keeps it.
        let both = clean(map(&[("date", "y"), ("today", "y")]));
        assert_eq!(both, map(&[("date", "y")]));
    }

    #[test]
    fn defaults_are_distinct_and_usable() {
        let mut seen = Vec::new();
        for &(_, c) in ACTIONS {
            assert!(usable(c), "{c}");
            assert!(!seen.contains(&c), "{c} twice");
            seen.push(c);
        }
    }
}

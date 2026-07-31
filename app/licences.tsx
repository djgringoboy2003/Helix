import React, { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { MaterialCommunityIcons } from '@expo/vector-icons';

import { LICENCE_DOCUMENTS } from '../constants/licenceText';
import { colors, radius, spacing } from '../constants/theme';
import { openUrl } from '../services/apkInstaller';
import { REPO_URL } from '../services/updateCheck';
import { t } from '../services/i18n';

// The licence, in the app rather than only on GitHub.
//
// Helix is AGPL-3.0-or-later. `CLAUDE.md` requires the licence files, the
// copyright notices, the third-party notices and the attribution to be kept —
// and a link is not keeping them: somebody holding the APK with no network, or
// after the repository moves, still has to be able to read what they were given
// and find out where the source is. The text is compiled in by
// `scripts/generate-licence-text.js` for that reason.
//
// The source offer is stated plainly at the top rather than buried, because
// under the AGPL it is the part that actually grants something.

export default function LicencesScreen() {
  const router = useRouter();
  const [active, setActive] = useState(LICENCE_DOCUMENTS[0]?.key ?? '');
  const document = LICENCE_DOCUMENTS.find((entry) => entry.key === active) ?? LICENCE_DOCUMENTS[0];

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.header}>
        <Pressable
          onPress={() => router.back()}
          hitSlop={12}
          accessibilityRole="button"
          accessibilityLabel={t('Back')}
        >
          <MaterialCommunityIcons name="arrow-left" size={24} color={colors.text} />
        </Pressable>
        <Text style={styles.title}>{t('Licences')}</Text>
      </View>

      <View style={styles.offer}>
        <Text style={styles.offerText}>
          Helix is free software under the GNU Affero General Public License,
          version 3 or later. It comes with no warranty.
        </Text>
        <Pressable
          style={styles.sourceRow}
          onPress={() => openUrl(REPO_URL).catch(() => {})}
          accessibilityRole="link"
          accessibilityLabel={t('Open the complete source code on GitHub')}
        >
          <MaterialCommunityIcons name="source-branch" size={18} color={colors.primary} />
          <Text style={styles.sourceText}>
            The complete corresponding source code is at {REPO_URL}
          </Text>
          <MaterialCommunityIcons name="open-in-new" size={14} color={colors.subtext} />
        </Pressable>
      </View>

      <View style={styles.tabs}>
        {LICENCE_DOCUMENTS.map((entry) => {
          const selected = entry.key === active;
          return (
            <Pressable
              key={entry.key}
              style={[styles.tab, selected && styles.tabActive]}
              onPress={() => setActive(entry.key)}
              accessibilityRole="tab"
              accessibilityState={{ selected }}
              accessibilityLabel={entry.title}
            >
              <Text style={[styles.tabText, selected && styles.tabTextActive]} numberOfLines={1}>
                {shortTitle(entry.title)}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {document ? (
        <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent}>
          <Text style={styles.documentTitle}>{document.title}</Text>
          <Text style={styles.sourceFile}>{document.sourceFile}</Text>
          {/* Monospaced: the AGPL's own layout carries meaning, and reflowing
              a licence is not something to do casually. */}
          <Text style={styles.documentText} selectable>
            {document.text}
          </Text>
        </ScrollView>
      ) : null}
    </SafeAreaView>
  );
}

/** Tab labels have very little room; the full title is the accessibility label. */
function shortTitle(title: string): string {
  if (title.startsWith('Licence')) return 'Licence';
  if (title.startsWith('Attribution')) return 'Attribution';
  return 'Third-party';
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  title: { color: colors.text, fontSize: 18, fontWeight: '800' },

  offer: {
    marginHorizontal: spacing.lg,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    gap: spacing.sm,
  },
  offerText: { color: colors.text, fontSize: 13, lineHeight: 19 },
  sourceRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  sourceText: { flex: 1, color: colors.primary, fontSize: 12, lineHeight: 17 },

  tabs: {
    flexDirection: 'row',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  tab: {
    flex: 1,
    paddingVertical: spacing.sm,
    borderRadius: radius.sm,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
  },
  tabActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  tabText: { color: colors.subtext, fontSize: 12, fontWeight: '700' },
  tabTextActive: { color: colors.text },

  body: { flex: 1, marginHorizontal: spacing.lg, marginBottom: spacing.lg },
  bodyContent: { paddingBottom: spacing.xl },
  documentTitle: { color: colors.text, fontSize: 14, fontWeight: '800' },
  documentFile: { color: colors.subtext, fontSize: 11 },
  sourceFile: { color: colors.subtext, fontSize: 11, marginBottom: spacing.md },
  documentText: {
    color: colors.subtext,
    fontSize: 11,
    lineHeight: 16,
    fontFamily: 'monospace',
  },
});

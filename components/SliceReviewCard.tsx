import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';

import { colors, radius, spacing } from '../constants/theme';
import { criticalSettings, type SliceReview } from '../services/gcode/SliceReview';
import { shortHash } from '../services/security/FileHash';

// What the slicer actually produced.
//
// `CLAUDE.md`'s workflow asks the operator to review **actual** G-code before
// anything reaches the printer, so this reports what was read out of the file —
// its real footprint, and the SHA-256 a start approval will bind to — rather
// than what the slice call returned.
//
// The hash is shown short. A full 64-character digest is unreadable, and the
// operator's job is to see that it *changed*, not to memorise it.

export default function SliceReviewCard({ review }: { review: SliceReview | null }) {
  if (!review) return null;

  const settings = criticalSettings(review);
  const blocking = review.findings.filter((item) => item.severity === 'blocking');
  const others = review.findings.filter((item) => item.severity !== 'blocking');

  return (
    <View style={[styles.card, blocking.length > 0 && styles.cardBlocked]}>
      <View style={styles.header}>
        <MaterialCommunityIcons
          name={blocking.length > 0 ? 'alert-octagon-outline' : 'file-check-outline'}
          size={18}
          color={blocking.length > 0 ? colors.danger : colors.success}
        />
        <Text style={styles.title}>
          {blocking.length > 0 ? 'This G-code has a problem' : 'Sliced G-code'}
        </Text>
        {review.sha256 ? (
          <Text style={styles.hash} accessibilityLabel="G-code fingerprint">
            {shortHash(review.sha256)}
          </Text>
        ) : null}
      </View>

      {blocking.map((item) => (
        <View key={item.code} style={styles.blockingRow}>
          <Text style={styles.blockingText}>{item.message}</Text>
        </View>
      ))}

      {settings.length > 0 ? (
        <View style={styles.grid}>
          {settings.map((item) => (
            <View key={item.label} style={styles.cell}>
              <Text style={styles.cellLabel}>{item.label}</Text>
              <Text style={styles.cellValue} numberOfLines={1}>
                {item.value}
              </Text>
            </View>
          ))}
        </View>
      ) : null}

      {others.map((item) => (
        <View key={item.code} style={styles.noticeRow}>
          <MaterialCommunityIcons
            name={item.severity === 'warning' ? 'alert-outline' : 'information-outline'}
            size={14}
            color={item.severity === 'warning' ? colors.warning : colors.subtext}
          />
          <Text style={styles.noticeText}>{item.message}</Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    gap: spacing.sm,
  },
  cardBlocked: { borderColor: colors.danger },
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  title: { flex: 1, color: colors.text, fontSize: 15, fontWeight: '700' },
  hash: { color: colors.subtext, fontSize: 11, fontWeight: '700' },
  blockingRow: { paddingVertical: 2 },
  blockingText: { color: colors.danger, fontSize: 13, lineHeight: 18, fontWeight: '600' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  cell: {
    minWidth: '30%',
    flexGrow: 1,
    backgroundColor: colors.cardAlt,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
  },
  cellLabel: { color: colors.subtext, fontSize: 10, fontWeight: '700', textTransform: 'uppercase' },
  cellValue: { color: colors.text, fontSize: 13, fontWeight: '600' },
  noticeRow: { flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-start' },
  noticeText: { flex: 1, color: colors.subtext, fontSize: 12, lineHeight: 17 },
});

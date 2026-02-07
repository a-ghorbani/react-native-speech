import React from 'react';
import type {
  TextSegmentProps,
  HighlightedTextProps,
  HighlightedSegmentProps,
} from '../types';
import {Text, StyleSheet} from 'react-native';

const HighlightedText: React.FC<HighlightedTextProps> = ({
  text,
  style,
  highlights = [],
  highlightedStyle,
  onHighlightedPress,
  ...rest
}) => {
  const baseStyle = [style, highlightedStyle ?? styles.isHighlighted];

  const segments = React.useMemo(() => {
    if (!text || !highlights.length) {
      return [];
    }
    let cursor = 0;
    let isSorted = true;

    const parts: TextSegmentProps[] = [];

    for (let i = 1; i < highlights.length; i++) {
      if (highlights[i - 1]!.start > highlights[i]!.start) {
        isSorted = false;
        break;
      }
    }
    const ordered = isSorted
      ? highlights
      : [...highlights].sort((a, b) => a.start - b.start);

    for (let i = 0; i < ordered.length; i++) {
      const {
        end,
        start,
        style: segmentStyle,
      } = ordered[i] as HighlightedSegmentProps;

      if (start >= text.length || end <= cursor) continue;

      const clampedStart = Math.max(cursor, start);
      const clampedEnd = Math.min(end, text.length);

      if (clampedStart > cursor) {
        parts.push({
          isHighlighted: false,
          text: text.slice(cursor, clampedStart),
        });
      }
      parts.push({
        end: clampedEnd,
        start: clampedStart,
        style: segmentStyle,
        isHighlighted: true,
        text: text.slice(clampedStart, clampedEnd),
      });

      cursor = clampedEnd;
    }
    if (cursor < text.length) {
      parts.push({
        isHighlighted: false,
        text: text.slice(cursor),
      });
    }
    return parts;
  }, [highlights, text]);

  const onHighlightedSegmentPress = React.useCallback(
    (segment: TextSegmentProps) => {
      if (!segment.isHighlighted) return;
      onHighlightedPress?.({
        end: segment.end!,
        start: segment.start!,
        text: segment.text,
      });
    },
    [onHighlightedPress],
  );

  const renderText = (segment: TextSegmentProps, index: number) => {
    const segmentStyle = segment.isHighlighted
      ? segment.style
        ? [baseStyle, segment.style]
        : baseStyle
      : style;

    return (
      <Text
        style={segmentStyle}
        suppressHighlighting
        key={`segment-${index}`}
        onPress={() => onHighlightedSegmentPress(segment)}>
        {segment.text}
      </Text>
    );
  };

  return (
    <Text style={style} {...rest}>
      {segments.length ? segments.map(renderText) : text}
    </Text>
  );
};

export default HighlightedText;

const styles = StyleSheet.create({
  isHighlighted: {
    backgroundColor: '#FFFF00',
  },
});

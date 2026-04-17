import React from 'react';
import {gs} from '../styles/gs';
import {
  Text,
  TouchableOpacity,
  useColorScheme,
  type TouchableOpacityProps,
} from 'react-native';

export type ButtonVariant = 'primary' | 'success' | 'danger' | 'secondary';

const VARIANT_COLORS: Record<ButtonVariant, {bg: string; text: string}> = {
  primary: {bg: '#007AFF', text: '#FFFFFF'},
  success: {bg: '#34C759', text: '#FFFFFF'},
  danger: {bg: '#FF3B30', text: '#FFFFFF'},
  secondary: {bg: 'transparent', text: '#007AFF'},
};

export interface ButtonProps extends TouchableOpacityProps {
  label: string;
  variant?: ButtonVariant;
}

const Button: React.FC<ButtonProps> = ({
  label,
  disabled,
  variant = 'primary',
  ...rest
}) => {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const colors = VARIANT_COLORS[variant];
  const bg =
    variant === 'secondary'
      ? isDark
        ? 'rgba(255,255,255,0.08)'
        : 'rgba(0,0,0,0.05)'
      : colors.bg;

  return (
    <TouchableOpacity
      activeOpacity={0.7}
      disabled={disabled}
      style={[gs.button, {backgroundColor: bg}, disabled && gs.disabled]}
      {...rest}>
      <Text style={[gs.buttonText, {color: colors.text}]}>{label}</Text>
    </TouchableOpacity>
  );
};

export default Button;

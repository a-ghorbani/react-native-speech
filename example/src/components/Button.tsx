import React from 'react';
import {gs} from '../styles/gs';
import {Text, TouchableOpacity, type TouchableOpacityProps} from 'react-native';

export type ButtonVariant = 'primary' | 'success' | 'danger' | 'secondary';

const VARIANTS: Record<
  ButtonVariant,
  {bg: string; border: string; text: string}
> = {
  primary: {bg: 'rgba(0,212,255,0.1)', border: '#00D4FF', text: '#00D4FF'},
  success: {bg: 'rgba(0,255,65,0.1)', border: '#00FF41', text: '#00FF41'},
  danger: {bg: 'rgba(255,0,64,0.1)', border: '#FF0040', text: '#FF0040'},
  secondary: {
    bg: 'rgba(255,255,255,0.03)',
    border: 'rgba(0,255,65,0.25)',
    text: 'rgba(0,255,65,0.6)',
  },
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
  const v = VARIANTS[variant];

  return (
    <TouchableOpacity
      activeOpacity={0.7}
      disabled={disabled}
      style={[
        gs.button,
        {backgroundColor: v.bg, borderColor: v.border},
        disabled && gs.disabled,
      ]}
      {...rest}>
      <Text style={[gs.buttonText, {color: v.text}]}>{label}</Text>
    </TouchableOpacity>
  );
};

export default Button;

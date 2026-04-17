import React from 'react';
import {gs} from '../styles/gs';
import {Text, TouchableOpacity, type TouchableOpacityProps} from 'react-native';
import {C} from '../styles/cyber';

export type ButtonVariant = 'primary' | 'success' | 'danger' | 'secondary';

const VARIANTS: Record<
  ButtonVariant,
  {bg: string; border: string; text: string; bracket: string}
> = {
  primary: {
    bg: C.cyanGhost,
    border: C.cyanBorder,
    text: C.cyan,
    bracket: C.cyanDim,
  },
  success: {
    bg: C.greenGhost,
    border: C.greenBorder,
    text: C.green,
    bracket: C.greenDim,
  },
  danger: {
    bg: C.redGhost,
    border: C.redBorder,
    text: C.red,
    bracket: C.redBorder,
  },
  secondary: {
    bg: 'rgba(255,255,255,0.02)',
    border: C.greenBorder,
    text: C.greenDim,
    bracket: C.muted,
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
      <Text
        style={[gs.buttonText, {color: v.text}]}
        numberOfLines={1}
        adjustsFontSizeToFit>
        <Text style={{color: v.bracket}}>{'['}</Text>
        {` ${label} `}
        <Text style={{color: v.bracket}}>{']'}</Text>
      </Text>
    </TouchableOpacity>
  );
};

export default Button;

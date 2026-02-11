import type { ReactNode, ButtonHTMLAttributes } from 'react';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode;
  variant?: 'primary' | 'danger' | 'ghost';
  size?: 'sm' | 'md' | 'lg';
  fullWidth?: boolean;
  loading?: boolean;
}

export function Button({
  children,
  variant = 'primary',
  size = 'md',
  fullWidth = false,
  loading = false,
  disabled,
  className = '',
  ...props
}: ButtonProps) {
  const baseStyles = 'inline-flex items-center justify-center font-medium rounded-sm transition-all duration-150 touch-target btn-active no-select uppercase tracking-wider border';

  const variantStyles = {
    primary: 'border-primary text-primary bg-transparent hover:bg-primary/10 disabled:border-primary/30 disabled:text-primary/30',
    danger: 'border-status-error text-status-error bg-transparent hover:bg-status-error/10 disabled:border-status-error/30 disabled:text-status-error/30',
    ghost: 'border-border text-text bg-transparent hover:bg-surface-alt disabled:opacity-30',
  };

  const sizeStyles = {
    sm: 'px-3 py-1.5 text-xs min-h-[36px]',
    md: 'px-4 py-2 text-sm min-h-[44px]',
    lg: 'px-6 py-3 text-sm min-h-[52px]',
  };

  const widthStyles = fullWidth ? 'w-full' : '';

  return (
    <button
      className={`${baseStyles} ${variantStyles[variant]} ${sizeStyles[size]} ${widthStyles} ${className}`}
      disabled={disabled || loading}
      {...props}
    >
      {loading ? (
        <>
          <span className="spinner mr-2" />
          LOADING...
        </>
      ) : (
        children
      )}
    </button>
  );
}

import React from 'react';
import {
    ActivityIndicator,
    Pressable,
    StyleSheet,
    Text,
    TextInput,
    TextInputProps,
    View,
    ViewStyle
} from 'react-native';
import { colors, radius, spacing } from '../theme';

export function Button(props: {
    title: string;
    onPress?: () => void;
    variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
    disabled?: boolean;
    loading?: boolean;
    small?: boolean;
    style?: ViewStyle;
}) {
    const { variant = 'primary', small } = props;
    const backgrounds: Record<string, string> = {
        primary: colors.brand,
        secondary: colors.surface,
        danger: colors.danger,
        ghost: 'transparent'
    };
    const textColors: Record<string, string> = {
        primary: '#161006',
        secondary: colors.text,
        danger: '#fff',
        ghost: colors.textDim
    };

    return (
        <Pressable
            accessibilityRole='button'
            onPress={props.onPress}
            disabled={props.disabled || props.loading}
            style={({ pressed }) => [
                styles.button,
                small && styles.buttonSmall,
                { backgroundColor: backgrounds[variant] },
                variant === 'secondary' && { borderWidth: 1, borderColor: colors.border },
                (props.disabled || props.loading) && { opacity: 0.5 },
                pressed && { opacity: 0.75 },
                props.style
            ]}
        >
            {props.loading ? (
                <ActivityIndicator color={textColors[variant]} />
            ) : (
                <Text
                    style={[
                        styles.buttonText,
                        small && styles.buttonTextSmall,
                        { color: textColors[variant] }
                    ]}
                >
                    {props.title}
                </Text>
            )}
        </Pressable>
    );
}

export function TextField(
    props: TextInputProps & { label?: string; error?: string; containerStyle?: ViewStyle }
) {
    const { label, error, containerStyle, style, ...rest } = props;
    return (
        <View style={[{ marginBottom: spacing.md }, containerStyle]}>
            {label ? <Text style={styles.fieldLabel}>{label}</Text> : null}
            <TextInput
                placeholderTextColor={colors.textFaint}
                autoCapitalize='none'
                autoCorrect={false}
                {...rest}
                style={[styles.input, error ? { borderColor: colors.danger } : null, style]}
            />
            {error ? <Text style={styles.fieldError}>{error}</Text> : null}
        </View>
    );
}

export function Card(props: { children: React.ReactNode; style?: ViewStyle }) {
    return <View style={[styles.card, props.style]}>{props.children}</View>;
}

export function Badge(props: { text: string; color?: string; textColor?: string }) {
    return (
        <View
            style={[
                styles.badge,
                { backgroundColor: props.color ?? colors.surfaceHover }
            ]}
        >
            <Text style={[styles.badgeText, { color: props.textColor ?? colors.textDim }]}>
                {props.text}
            </Text>
        </View>
    );
}

export function EmptyState(props: { title: string; subtitle?: string }) {
    return (
        <View style={styles.empty}>
            <Text style={styles.emptyTitle}>{props.title}</Text>
            {props.subtitle ? <Text style={styles.emptySubtitle}>{props.subtitle}</Text> : null}
        </View>
    );
}

export function ErrorBanner(props: { message?: string }) {
    if (!props.message) {
        return null;
    }
    return (
        <View style={styles.errorBanner}>
            <Text style={styles.errorBannerText}>{props.message}</Text>
        </View>
    );
}

const styles = StyleSheet.create({
    button: {
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: 13,
        paddingHorizontal: spacing.lg,
        borderRadius: radius.md
    },
    buttonSmall: {
        paddingVertical: 7,
        paddingHorizontal: spacing.md,
        borderRadius: radius.sm
    },
    buttonText: {
        fontSize: 16,
        fontWeight: '700'
    },
    buttonTextSmall: {
        fontSize: 13
    },
    fieldLabel: {
        color: colors.textDim,
        fontSize: 13,
        fontWeight: '600',
        marginBottom: 6
    },
    fieldError: {
        color: colors.danger,
        fontSize: 12,
        marginTop: 4
    },
    input: {
        backgroundColor: colors.bgElevated,
        borderColor: colors.border,
        borderWidth: 1,
        borderRadius: radius.md,
        color: colors.text,
        fontSize: 16,
        paddingHorizontal: spacing.md,
        paddingVertical: 12
    },
    card: {
        backgroundColor: colors.surface,
        borderColor: colors.border,
        borderWidth: 1,
        borderRadius: radius.lg,
        padding: spacing.lg
    },
    badge: {
        borderRadius: radius.pill,
        paddingHorizontal: 8,
        paddingVertical: 3,
        alignSelf: 'flex-start'
    },
    badgeText: {
        fontSize: 11,
        fontWeight: '700',
        textTransform: 'uppercase',
        letterSpacing: 0.5
    },
    empty: {
        alignItems: 'center',
        paddingVertical: 48,
        paddingHorizontal: spacing.xl
    },
    emptyTitle: {
        color: colors.textDim,
        fontSize: 16,
        fontWeight: '600',
        textAlign: 'center'
    },
    emptySubtitle: {
        color: colors.textFaint,
        fontSize: 13,
        marginTop: 6,
        textAlign: 'center'
    },
    errorBanner: {
        backgroundColor: 'rgba(229, 72, 77, 0.15)',
        borderColor: colors.danger,
        borderWidth: 1,
        borderRadius: radius.md,
        padding: spacing.md,
        marginBottom: spacing.md
    },
    errorBannerText: {
        color: '#ff8f93',
        fontSize: 13
    }
});

import React, { useEffect, useRef } from 'react';

interface AutoResizeTextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
    value: string;
}

export const AutoResizeTextarea: React.FC<AutoResizeTextareaProps> = ({ value, className, onChange, ...props }) => {
    const textareaRef = useRef<HTMLTextAreaElement>(null);

    const resize = () => {
        const textarea = textareaRef.current;
        if (textarea) {
            textarea.style.height = 'auto';
            textarea.style.height = `${textarea.scrollHeight}px`;
        }
    };

    React.useLayoutEffect(() => {
        resize();
    }, [value]);

    const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        if (onChange) onChange(e);
        resize();
    };

    return (
        <textarea
            ref={textareaRef}
            value={value}
            onChange={handleChange}
            className={`${className} overflow-hidden resize-none`}
            {...props}
        />
    );
};

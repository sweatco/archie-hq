import React, { useState } from 'react';
import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';

interface MessageInputProps {
  onSubmit: (message: string) => void;
  active: boolean;
  placeholder?: string;
}

export function MessageInput({ onSubmit, active, placeholder }: MessageInputProps) {
  const [value, setValue] = useState('');

  const handleSubmit = (text: string) => {
    if (text.trim()) {
      onSubmit(text.trim());
      setValue('');
    }
  };

  return (
    <Box>
      <Text color="cyan">&gt; </Text>
      {active ? (
        <TextInput
          value={value}
          onChange={setValue}
          onSubmit={handleSubmit}
          placeholder={placeholder || 'Type a message to PM...'}
        />
      ) : (
        <Text dimColor>{placeholder || 'Press Tab to type...'}</Text>
      )}
    </Box>
  );
}

import { Box, Text, render, useApp, useInput } from 'ink';
import { createInterface } from 'node:readline/promises';
import React, { useMemo, useState } from 'react';

import type { PromptApi, SelectOption } from '@agentpm/shared';
import { AgentPmError } from '@agentpm/shared';

interface SelectComponentProps<T> {
  message: string;
  options: SelectOption<T>[];
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}

function SelectComponent<T>({
  message,
  options,
  resolve,
  reject,
}: SelectComponentProps<T>): React.JSX.Element {
  const [index, setIndex] = useState(0);
  const { exit } = useApp();

  useInput((input, key) => {
    if (key.upArrow) {
      setIndex((current: number) =>
        current === 0 ? options.length - 1 : current - 1,
      );
      return;
    }

    if (key.downArrow) {
      setIndex((current: number) =>
        current === options.length - 1 ? 0 : current + 1,
      );
      return;
    }

    if (key.return) {
      resolve(options[index]!.value);
      exit();
      return;
    }

    if (input === 'q' || key.escape) {
      reject(new AgentPmError('Interactive selection cancelled.'));
      exit();
    }
  });

  return (
    <Box flexDirection="column">
      <Text>{message}</Text>
      <Text dimColor>
        Use arrow keys to choose, Enter to confirm, q to cancel.
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {options.map((option, optionIndex) => (
          <Text
            key={`${option.label}-${optionIndex}`}
            {...(optionIndex === index ? { color: 'cyan' as const } : {})}
          >
            {optionIndex === index ? '>' : ' '} {option.label}
            {option.description ? `  ${option.description}` : ''}
          </Text>
        ))}
      </Box>
    </Box>
  );
}

interface ConfirmComponentProps {
  message: string;
  details: string[];
  resolve: (value: boolean) => void;
}

interface MultiSelectComponentProps<T> {
  message: string;
  options: SelectOption<T>[];
  resolve: (value: T[]) => void;
  reject: (error: Error) => void;
}

function ConfirmComponent({
  message,
  details,
  resolve,
}: ConfirmComponentProps): React.JSX.Element {
  const [value, setValue] = useState(false);
  const { exit } = useApp();
  const options = useMemo(() => ['Yes', 'No'], []);

  useInput((input, key) => {
    if (key.leftArrow || key.upArrow || input.toLowerCase() === 'y') {
      setValue(true);
      return;
    }

    if (key.rightArrow || key.downArrow || input.toLowerCase() === 'n') {
      setValue(false);
      return;
    }

    if (key.return) {
      resolve(value);
      exit();
    }
  });

  return (
    <Box flexDirection="column">
      <Text>{message}</Text>
      {details.map((detail) => (
        <Text key={detail} dimColor>
          {detail}
        </Text>
      ))}
      <Box marginTop={1}>
        {options.map((option: string) => {
          const active = (option === 'Yes') === value;
          return (
            <Text key={option} {...(active ? { color: 'cyan' as const } : {})}>
              {active ? `[${option}]` : option}
              {'  '}
            </Text>
          );
        })}
      </Box>
    </Box>
  );
}

function MultiSelectComponent<T>({
  message,
  options,
  resolve,
  reject,
}: MultiSelectComponentProps<T>): React.JSX.Element {
  const [index, setIndex] = useState(0);
  const [selected, setSelected] = useState<Set<number>>(
    () => new Set(options.map((_, optionIndex) => optionIndex)),
  );
  const { exit } = useApp();

  useInput((input, key) => {
    if (key.upArrow) {
      setIndex((current: number) =>
        current === 0 ? options.length - 1 : current - 1,
      );
      return;
    }

    if (key.downArrow) {
      setIndex((current: number) =>
        current === options.length - 1 ? 0 : current + 1,
      );
      return;
    }

    if (input === ' ') {
      setSelected((current) => {
        const next = new Set(current);
        if (next.has(index)) {
          next.delete(index);
        } else {
          next.add(index);
        }
        return next;
      });
      return;
    }

    if (input.toLowerCase() === 'a') {
      setSelected(new Set(options.map((_, optionIndex) => optionIndex)));
      return;
    }

    if (input.toLowerCase() === 'n') {
      setSelected(new Set());
      return;
    }

    if (key.return) {
      resolve(
        options
          .filter((_, optionIndex) => selected.has(optionIndex))
          .map((option) => option.value),
      );
      exit();
      return;
    }

    if (input === 'q' || key.escape) {
      reject(new AgentPmError('Interactive selection cancelled.'));
      exit();
    }
  });

  return (
    <Box flexDirection="column">
      <Text>{message}</Text>
      <Text dimColor>
        Use arrows to move, Space to toggle, a for all, n for none, Enter to
        confirm, q to cancel.
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {options.map((option, optionIndex) => {
          const active = optionIndex === index;
          const checked = selected.has(optionIndex);
          return (
            <Text
              key={`${option.label}-${optionIndex}`}
              {...(active ? { color: 'cyan' as const } : {})}
            >
              {active ? '>' : ' '} [{checked ? 'x' : ' '}] {option.label}
              {option.description ? `  ${option.description}` : ''}
            </Text>
          );
        })}
      </Box>
    </Box>
  );
}

export async function promptToSelectOne<T>(
  message: string,
  options: SelectOption<T>[],
): Promise<T> {
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    throw new AgentPmError(
      'Interactive selection requires a TTY. Provide a concrete name or flag.',
    );
  }

  if (options.length === 0) {
    throw new AgentPmError('No options available for selection.');
  }

  return new Promise<T>((resolve, reject) => {
    const instance = render(
      <SelectComponent
        message={message}
        options={options}
        resolve={resolve}
        reject={reject}
      />,
    );
    instance.waitUntilExit().catch(reject);
  });
}

export async function promptToConfirm(
  message: string,
  details: string[] = [],
): Promise<boolean> {
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    throw new AgentPmError('Interactive confirmation requires a TTY.');
  }

  return new Promise<boolean>((resolve, reject) => {
    const instance = render(
      <ConfirmComponent
        message={message}
        details={details}
        resolve={resolve}
      />,
    );
    instance.waitUntilExit().catch(reject);
  });
}

export async function promptToInput(
  message: string,
  options: {
    defaultValue?: string | undefined;
    placeholder?: string | undefined;
    mask?: boolean | undefined;
  } = {},
): Promise<string> {
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    throw new AgentPmError('Interactive text input requires a TTY.');
  }

  const output = process.stdout;
  const rl = createInterface({
    input: process.stdin,
    output,
    terminal: true,
  });
  // Muted echo for secrets: swallow the echoed characters while typing.
  let muted = false;
  if (options.mask) {
    const write = output.write.bind(output);
    (rl as unknown as { _writeToOutput: (chunk: string) => void })._writeToOutput = (
      chunk: string,
    ) => {
      if (muted) {
        // Preserve newlines so Enter still moves the cursor.
        write(chunk.includes('\n') ? '\n' : '');
        return;
      }
      write(chunk);
    };
  }
  try {
    const suffix = [
      options.placeholder ? ` (${options.placeholder})` : '',
      options.defaultValue ? ` [default: ${options.defaultValue}]` : '',
    ].join('');
    const questionPromise = rl.question(`${message}${suffix}: `);
    muted = Boolean(options.mask);
    const answer = await questionPromise;
    if (options.mask) {
      output.write('\n');
    }
    const value = answer.trim();
    return value || options.defaultValue || '';
  } finally {
    rl.close();
  }
}

export async function promptToSelectMany<T>(
  message: string,
  options: SelectOption<T>[],
): Promise<T[]> {
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    throw new AgentPmError(
      'Interactive selection requires a TTY. Provide a concrete name or flag.',
    );
  }

  if (options.length === 0) {
    throw new AgentPmError('No options available for selection.');
  }

  return new Promise<T[]>((resolve, reject) => {
    const instance = render(
      <MultiSelectComponent
        message={message}
        options={options}
        resolve={resolve}
        reject={reject}
      />,
    );
    instance.waitUntilExit().catch(reject);
  });
}

export function createPromptApi(): PromptApi {
  return {
    selectOne: promptToSelectOne,
    selectMany: promptToSelectMany,
    confirm: promptToConfirm,
    input: promptToInput,
  };
}

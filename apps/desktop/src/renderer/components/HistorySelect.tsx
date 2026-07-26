import React from 'react';
import { Button, Select } from '@arco-design/web-react';

export function HistorySelect(props: {
  value: string;
  ariaLabel: string;
  placeholder: string;
  options: string[];
  onChange: (value: any) => void;
  onDeleteHistory: () => void;
}) {
  const { value, ariaLabel, placeholder, options, onChange, onDeleteHistory } = props;
  return (
    <div className="history-select-row">
      <div className="history-select-main" title={value}>
        <Select
          aria-label={ariaLabel}
          showSearch
          allowCreate
          value={value}
          placeholder={placeholder}
          onChange={onChange}
        >
          {options.map((option) => (
            <Select.Option key={option} value={option}>
              {option}
            </Select.Option>
          ))}
        </Select>
      </div>
      <Button
        className="history-delete-button"
        aria-label={`删除当前${ariaLabel}历史记录`}
        title="删除当前历史记录"
        onClick={onDeleteHistory}
      >
        <span className="history-delete-symbol" aria-hidden="true">×</span>
      </Button>
    </div>
  );
}

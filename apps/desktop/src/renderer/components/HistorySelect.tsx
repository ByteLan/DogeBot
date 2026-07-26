import React from 'react';
import { Button, Select } from '@arco-design/web-react';

// 收敛原先三处重复的「历史下拉 + 删除历史按钮」结构，渲染出的 DOM 与原实现一致。
export function HistorySelect(props: {
  value: string;
  placeholder: string;
  options: string[];
  onChange: (value: any) => void;
  onDeleteHistory: () => void;
}) {
  const { value, placeholder, options, onChange, onDeleteHistory } = props;
  return (
    <div className="history-select-row">
      <div className="history-select-main">
        <Select
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
      <Button size="mini" onClick={onDeleteHistory}>删除历史</Button>
    </div>
  );
}

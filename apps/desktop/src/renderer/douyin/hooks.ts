import { useEffect, type Dispatch, type SetStateAction } from 'react';
import { extractAwemeIds } from '../../shared/aweme';
import type { ApiClient } from '../api';
import type { DouyinClickResult, DouyinCollectResult, DouyinEvent, DouyinTaskState } from '../types';
import { appendEventRecord, parseCollectListBody } from './utils';

// 订阅 Douyin 主进程桥接事件：与原 App 内的 useEffect 逐字一致，依赖数组保持 [api]。
export function useDouyinBridge(params: {
  api: ApiClient;
  setDouyinTaskStates: Dispatch<SetStateAction<Record<string, DouyinTaskState>>>;
  setDouyinStatus: Dispatch<SetStateAction<string>>;
  setDouyinTaskStatusMap: Dispatch<SetStateAction<Record<string, string>>>;
  setDouyinTaskEvents: Dispatch<SetStateAction<Record<string, DouyinEvent[]>>>;
}) {
  const { api, setDouyinTaskStates, setDouyinStatus, setDouyinTaskStatusMap, setDouyinTaskEvents } = params;
  useEffect(() => {
    if (!window.douyin) return;
    console.log('[douyin renderer] bridge ready');
    window.douyin.getTasksState().then(setDouyinTaskStates).catch((error) => console.error('[douyin renderer] get tasks state failed', error));

    const addTaskEvent = (taskId: string, title: string, data: unknown) => {
      const event: DouyinEvent = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        title,
        data
      };
      setDouyinTaskEvents((records) => appendEventRecord(records, taskId, event));
    };

    const offClick = window.douyin.onClickResult((data) => {
      const result = data as DouyinClickResult;
      const taskId = typeof result.taskId === 'string' ? result.taskId : '';
      if (!taskId) return;
      const taskText = result.taskClickText || '未命名任务';
      const messageText = result.skipped
        ? '已刷新页面并跳过点击，继续等待接口返回'
        : result.clicked
          ? `已点击：${result.text || taskText}`
          : `点击失败：${result.reason || '未知原因'}`;
      setDouyinTaskStatusMap((records) => ({ ...records, [taskId]: messageText }));
      setDouyinStatus(`${taskText}：${messageText}`);
    });

    const offList = window.douyin.onCollectsVideoList((data) => {
      const payload = data as DouyinCollectResult;
      const taskId = typeof payload.taskId === 'string' ? payload.taskId : '';
      if (!taskId) return;
      const isTimeoutEvent = payload.source === 'monitor-timeout';
      const body = parseCollectListBody(payload);
      const awemeIds = Array.isArray(payload.awemeIds)
        ? payload.awemeIds.map((id) => String(id || '').trim()).filter(Boolean)
        : extractAwemeIds(body);
      const taskText = payload.taskClickText || '未命名任务';
      if (!isTimeoutEvent) {
        addTaskEvent(taskId, `${taskText} · ${payload.url || payload.taskCollectListUrl || 'collects/video/list'}`, body ?? payload);
      }
      if (payload.error) {
        const errorText = isTimeoutEvent ? payload.error : `接口捕获失败：${payload.error}`;
        setDouyinTaskStatusMap((records) => ({ ...records, [taskId]: errorText }));
        setDouyinStatus(`${taskText}：${errorText}`);
        return;
      }
      if (awemeIds.length === 0) {
        const emptyText = '接口已返回，但未提取到 aweme_id';
        setDouyinTaskStatusMap((records) => ({ ...records, [taskId]: emptyText }));
        setDouyinStatus(`${taskText}：${emptyText}`);
        return;
      }
      if (payload.changed === false) {
        const skipText = `已收集 ${awemeIds.length} 个 aweme_id，全部已见过，跳过上传`;
        setDouyinTaskStatusMap((records) => ({ ...records, [taskId]: skipText }));
        setDouyinStatus(`${taskText}：${skipText}`);
        return;
      }
      api<{ inserted: number; total: number }>('/api/douyin/aweme-records', {
        method: 'POST',
        body: JSON.stringify({ clickText: taskText, awemeIds })
      })
        .then((result) => {
          const successText = `已同步 ${awemeIds.length} 个 aweme_id，新增 ${result.inserted} 个，当前累计 ${result.total} 个`;
          setDouyinTaskStatusMap((records) => ({ ...records, [taskId]: successText }));
          setDouyinStatus(`${taskText}：${successText}`);
        })
        .catch((error) => {
          console.error('[douyin renderer] upload aweme ids failed', error);
          const errorText = error instanceof Error ? `同步 aweme_id 失败：${error.message}` : '同步 aweme_id 失败';
          setDouyinTaskStatusMap((records) => ({ ...records, [taskId]: errorText }));
          setDouyinStatus(`${taskText}：${errorText}`);
        });
    });

    const offState = window.douyin.onTasksState(setDouyinTaskStates);
    return () => {
      offClick();
      offList();
      offState();
    };
  }, [api]);
}

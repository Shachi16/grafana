import React, { FC, useCallback, useEffect, useMemo, useState } from 'react';
import { Button, HorizontalGroup, IconButton } from '@grafana/ui';
import { AmRouteReceiver, FormAmRoute } from '../../types/amroutes';
import { prepareItems } from '../../utils/dynamicTable';
import { DynamicTable, DynamicTableColumnProps, DynamicTableItemProps } from '../DynamicTable';
import { AmRoutesExpandedForm } from './AmRoutesExpandedForm';
import { AmRoutesExpandedRead } from './AmRoutesExpandedRead';
import { Matchers } from '../silences/Matchers';
import { matcherFieldToMatcher, parseMatchers } from '../../utils/alertmanager';
import { intersectionWith, isEqual } from 'lodash';
import { EmptyArea } from '../EmptyArea';

export interface AmRoutesTableProps {
  isAddMode: boolean;
  onChange: (routes: FormAmRoute[]) => void;
  onCancelAdd: () => void;
  receivers: AmRouteReceiver[];
  routes: FormAmRoute[];
  filters?: { queryString?: string; contactPoint?: string };
  readOnly?: boolean;
}

type RouteTableColumnProps = DynamicTableColumnProps<FormAmRoute>;
type RouteTableItemProps = DynamicTableItemProps<FormAmRoute>;

export const getFilteredRoutes = (routes: FormAmRoute[], labelMatcherQuery?: string, contactPointQuery?: string) => {
  const matchers = parseMatchers(labelMatcherQuery ?? '');

  let filteredRoutes = routes;

  if (matchers.length) {
    filteredRoutes = routes.filter((route) => {
      const routeMatchers = route.object_matchers.map(matcherFieldToMatcher);
      return intersectionWith(routeMatchers, matchers, isEqual).length > 0;
    });
  }

  if (contactPointQuery && contactPointQuery.length > 0) {
    filteredRoutes = filteredRoutes.filter((route) =>
      route.receiver.toLowerCase().includes(contactPointQuery.toLowerCase())
    );
  }

  return filteredRoutes;
};

export const AmRoutesTable: FC<AmRoutesTableProps> = ({
  isAddMode,
  onCancelAdd,
  onChange,
  receivers,
  routes,
  filters,
  readOnly = false,
}) => {
  const [editMode, setEditMode] = useState(false);
  const [expandedId, setExpandedId] = useState<string | number>();

  const expandItem = useCallback((item: RouteTableItemProps) => setExpandedId(item.id), []);
  const collapseItem = useCallback(() => setExpandedId(undefined), []);

  const cols: RouteTableColumnProps[] = [
    {
      id: 'matchingCriteria',
      label: 'Matching labels',
      // eslint-disable-next-line react/display-name
      renderCell: (item) => <Matchers matchers={item.data.object_matchers.map(matcherFieldToMatcher)} />,
      size: 10,
    },
    {
      id: 'groupBy',
      label: 'Group by',
      renderCell: (item) => item.data.groupBy.join(', ') || '-',
      size: 5,
    },
    {
      id: 'receiverChannel',
      label: 'Contact point',
      renderCell: (item) => item.data.receiver || '-',
      size: 5,
    },
    {
      id: 'muteTimings',
      label: 'Mute timings',
      renderCell: (item) => item.data.muteTimeIntervals.join(', ') || '-',
      size: 5,
    },
    ...(readOnly
      ? []
      : [
          {
            id: 'actions',
            label: 'Actions',
            // eslint-disable-next-line react/display-name
            renderCell: (item, index) => {
              if (item.renderExpandedContent) {
                return null;
              }

              const expandWithCustomContent = () => {
                expandItem(item);
                setEditMode(true);
              };

              return (
                <HorizontalGroup>
                  <Button
                    aria-label="Edit route"
                    icon="pen"
                    onClick={expandWithCustomContent}
                    size="sm"
                    type="button"
                    variant="secondary"
                  >
                    Edit
                  </Button>
                  <IconButton
                    aria-label="Delete route"
                    name="trash-alt"
                    onClick={() => {
                      const newRoutes = [...routes];

                      newRoutes.splice(index, 1);

                      onChange(newRoutes);
                    }}
                    type="button"
                  />
                </HorizontalGroup>
              );
            },
            size: '100px',
          } as RouteTableColumnProps,
        ]),
  ];

  const filteredRoutes = useMemo(() => getFilteredRoutes(routes, filters?.queryString, filters?.contactPoint), [
    routes,
    filters,
  ]);

  const dynamicTableRoutes = useMemo(() => prepareItems(isAddMode ? routes : filteredRoutes), [
    isAddMode,
    routes,
    filteredRoutes,
  ]);

  // expand the last item when adding
  useEffect(() => {
    if (isAddMode && dynamicTableRoutes.length) {
      setExpandedId(dynamicTableRoutes[dynamicTableRoutes.length - 1].id);
    }
  }, [isAddMode, dynamicTableRoutes]);

  if (routes.length > 0 && filteredRoutes.length === 0) {
    return (
      <EmptyArea>
        <p>No policies found</p>
      </EmptyArea>
    );
  }

  return (
    <DynamicTable
      cols={cols}
      isExpandable={true}
      items={dynamicTableRoutes}
      testIdGenerator={() => 'am-routes-row'}
      onCollapse={collapseItem}
      onExpand={expandItem}
      isExpanded={(item) => expandedId === item.id}
      renderExpandedContent={(item: RouteTableItemProps, index) =>
        isAddMode || editMode ? (
          <AmRoutesExpandedForm
            onCancel={() => {
              if (isAddMode) {
                onCancelAdd();
              }
              setEditMode(false);
            }}
            onSave={(data) => {
              const newRoutes = [...routes];

              newRoutes[index] = {
                ...newRoutes[index],
                ...data,
              };
              setEditMode(false);
              onChange(newRoutes);
            }}
            receivers={receivers}
            routes={item.data}
          />
        ) : (
          <AmRoutesExpandedRead
            onChange={(data) => {
              const newRoutes = [...routes];

              newRoutes[index] = {
                ...item.data,
                ...data,
              };

              onChange(newRoutes);
            }}
            receivers={receivers}
            routes={item.data}
            readOnly={readOnly}
          />
        )
      }
    />
  );
};

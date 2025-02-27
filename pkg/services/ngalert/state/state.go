package state

import (
	"errors"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/data"

	"github.com/grafana/grafana/pkg/expr"
	"github.com/grafana/grafana/pkg/services/ngalert/eval"
	ngModels "github.com/grafana/grafana/pkg/services/ngalert/models"
)

type State struct {
	AlertRuleUID       string
	OrgID              int64
	CacheId            string
	State              eval.State
	Resolved           bool
	Results            []Evaluation
	StartsAt           time.Time
	EndsAt             time.Time
	LastEvaluationTime time.Time
	EvaluationDuration time.Duration
	LastSentAt         time.Time
	Annotations        map[string]string
	Labels             data.Labels
	Error              error
}

type Evaluation struct {
	EvaluationTime   time.Time
	EvaluationState  eval.State
	EvaluationString string
	// Values contains the RefID and value of reduce and math expressions.
	// It does not contain values for classic conditions as the values
	// in classic conditions do not have a RefID.
	Values map[string]*float64
}

// NewEvaluationValues returns the labels and values for each RefID in the capture.
func NewEvaluationValues(m map[string]eval.NumberValueCapture) map[string]*float64 {
	result := make(map[string]*float64, len(m))
	for k, v := range m {
		result[k] = v.Value
	}
	return result
}

func (a *State) resultNormal(alertRule *ngModels.AlertRule, result eval.Result) {
	a.Error = result.Error // should be nil since state is not error

	if a.State != eval.Normal {
		a.EndsAt = result.EvaluatedAt
		a.StartsAt = result.EvaluatedAt
	}
	a.State = eval.Normal
}

func (a *State) resultAlerting(alertRule *ngModels.AlertRule, result eval.Result) {
	a.Error = result.Error // should be nil since the state is not an error

	switch a.State {
	case eval.Alerting:
		a.setEndsAt(alertRule, result)
	case eval.Pending:
		if result.EvaluatedAt.Sub(a.StartsAt) > alertRule.For {
			a.State = eval.Alerting
			a.StartsAt = result.EvaluatedAt
			a.setEndsAt(alertRule, result)
		}
	default:
		a.StartsAt = result.EvaluatedAt
		a.setEndsAt(alertRule, result)
		if !(alertRule.For > 0) {
			// If For is 0, immediately set Alerting
			a.State = eval.Alerting
		} else {
			a.State = eval.Pending
		}
	}
}

func (a *State) resultError(alertRule *ngModels.AlertRule, result eval.Result) {
	a.Error = result.Error

	if a.StartsAt.IsZero() {
		a.StartsAt = result.EvaluatedAt
	}
	a.setEndsAt(alertRule, result)

	if alertRule.ExecErrState == ngModels.AlertingErrState {
		a.State = eval.Alerting
	} else if alertRule.ExecErrState == ngModels.ErrorErrState {
		a.State = eval.Error

		// If the evaluation failed because a query returned an error then
		// update the state with the Datasource UID as a label and the error
		// message as an annotation so other code can use this metadata to
		// add context to alerts
		var queryError expr.QueryError
		if errors.As(a.Error, &queryError) {
			for _, next := range alertRule.Data {
				if next.RefID == queryError.RefID {
					a.Labels["ref_id"] = next.RefID
					a.Labels["datasource_uid"] = next.DatasourceUID
					break
				}
			}
			a.Annotations["Error"] = queryError.Error()
		}
	}
}

func (a *State) resultNoData(alertRule *ngModels.AlertRule, result eval.Result) {
	a.Error = result.Error

	if a.StartsAt.IsZero() {
		a.StartsAt = result.EvaluatedAt
	}
	a.setEndsAt(alertRule, result)

	switch alertRule.NoDataState {
	case ngModels.Alerting:
		a.State = eval.Alerting
	case ngModels.NoData:
		a.State = eval.NoData
	case ngModels.OK:
		a.State = eval.Normal
	}
}

func (a *State) NeedsSending(resendDelay time.Duration) bool {
	if a.State == eval.Pending || a.State == eval.Normal && !a.Resolved {
		return false
	}
	// if LastSentAt is before or equal to LastEvaluationTime + resendDelay, send again
	nextSent := a.LastSentAt.Add(resendDelay)
	return nextSent.Before(a.LastEvaluationTime) || nextSent.Equal(a.LastEvaluationTime)
}

func (a *State) Equals(b *State) bool {
	return a.AlertRuleUID == b.AlertRuleUID &&
		a.OrgID == b.OrgID &&
		a.CacheId == b.CacheId &&
		a.Labels.String() == b.Labels.String() &&
		a.State.String() == b.State.String() &&
		a.StartsAt == b.StartsAt &&
		a.EndsAt == b.EndsAt &&
		a.LastEvaluationTime == b.LastEvaluationTime &&
		data.Labels(a.Annotations).String() == data.Labels(b.Annotations).String()
}

func (a *State) TrimResults(alertRule *ngModels.AlertRule) {
	numBuckets := 2 * (int64(alertRule.For.Seconds()) / alertRule.IntervalSeconds)
	if numBuckets == 0 {
		numBuckets = 10 // keep at least 10 evaluations in the event For is set to 0
	}

	if len(a.Results) < int(numBuckets) {
		return
	}
	newResults := make([]Evaluation, numBuckets)
	copy(newResults, a.Results[len(a.Results)-int(numBuckets):])
	a.Results = newResults
}

// setEndsAt sets the ending timestamp of the alert.
// The internal Alertmanager will use this time to know when it should automatically resolve the alert
// in case it hasn't received additional alerts. Under regular operations the scheduler will continue to send the
// alert with an updated EndsAt, if the alert is resolved then a last alert is sent with EndsAt = last evaluation time.
func (a *State) setEndsAt(alertRule *ngModels.AlertRule, result eval.Result) {
	ends := ResendDelay
	if alertRule.IntervalSeconds > int64(ResendDelay.Seconds()) {
		ends = time.Second * time.Duration(alertRule.IntervalSeconds)
	}

	a.EndsAt = result.EvaluatedAt.Add(ends * 3)
}

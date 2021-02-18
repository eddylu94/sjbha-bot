import * as R from "ramda";
import * as t from "io-ts";
import * as E from "fp-ts/Either";
import * as TE from "fp-ts/TaskEither";
import { pipe, flow } from "fp-ts/lib/function";

import * as db from "@packages/db";
import { DecodeError, InvalidArgsError } from "@packages/common-errors";
import { Interval, DateTime } from "luxon";
import { Workout } from "./Workout";
import {User} from "./User";
import * as Time from "./Week";

const collection = db.collection<LoggedWorkout>('fit-exp');

export type LoggedWorkout = t.TypeOf<typeof LoggedWorkoutT>;
const LoggedWorkoutT = t.interface({
  discord_id: t.string,
  activity_id: t.number,
  activity_name: t.string,
  timestamp: t.string,
  activity_type: t.string,
  exp_type: t.union([t.literal('hr'), t.literal('time')]),
  exp_gained: t.number,
  exp_vigorous: t.number
});

const decode = flow(
  t.array(LoggedWorkoutT).decode, 
  E.mapLeft(DecodeError.fromError)
);

const find = (interval: Interval) => {
  return (q: db.Query<LoggedWorkout> = {}) => pipe(
    collection(),
    db.find <LoggedWorkout>({
      ...q,
      timestamp: {
        $lt: interval.end.toISO(),
        $gt: interval.start.toISO()
      }
    }),
    TE.chainEitherKW (decode)
  );
};

export const insert = (workout: LoggedWorkout) => {
  if (!workout.discord_id)
    return TE.left(InvalidArgsError.create("Trying to log a workout but no user is provided"));
  if (!workout.activity_id)
    return TE.left(InvalidArgsError.create("Trying to save workout without mapping to an activity"));

  return pipe(
    collection(),
    db.insert <LoggedWorkout>(workout)
  );
}

export const thirtyDayHistory = (user: User) => {
  const interval = Interval.before(
    DateTime.local(), 
    {days: 30}
  );

  return find(interval)({discord_id: user.discordId})
};

export const create = (props: LoggedWorkout = {
  discord_id: "",
  activity_id: -1,
  activity_name: "",
  timestamp: "",
  activity_type: "",
  exp_type: "time",
  exp_gained: 0,
  exp_vigorous: 0
}) => ({

  forUser: (user: User) => create({
    ...props,
    discord_id: user.discordId
  }),

  forWorkout: (workout: Workout) => create({
    ...props,
    activity_id: workout.id,
    activity_name: workout.title,
    timestamp: workout.timestamp.toISO(),
    activity_type: workout.type
  }),

  withExp: (type: LoggedWorkout["exp_type"], moderate: number, vigorous: number) => create({
    ...props,
    exp_type: type,
    exp_gained: moderate + vigorous,
    exp_vigorous: vigorous
  }),

  build: () => props
});

export const sumExp = (logs: LoggedWorkout[]) => logs
  .map(_ => _.exp_gained)
  .reduce(R.add, 0);

export const filterThisWeek = () => {
  const week = Time.thisWeek();
  return (logs: LoggedWorkout[]) => logs
    .filter(w => pipe(
      DateTime.fromISO (w.timestamp),
      date => {
        console.log("date " + date.toFormat("DD MM YYYY hh:mm"));
        console.log("start " + week.start.toFormat("DD MM YYYY hh:mm"));
        console.log("end " + week.end.toFormat("DD MM YYYY hh:mm"));

        const res= week.contains(date)
        console.log("res?", res);
        return res;
      }
    ));
};
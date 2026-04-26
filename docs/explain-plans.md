# EXPLAIN (ANALYZE, BUFFERS) — Read API hot queries

Captured against the seeded + 200 RPS post-load dataset (71k+ trades).
PostgreSQL 16, default planner, primary keys only.

## GET /users/:id/metrics?granularity=daily

```
                                                                                                    QUERY PLAN                                                                                                    
------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
 Sort  (cost=3.11..3.12 rows=1 width=29) (actual time=0.132..0.133 rows=1 loops=1)
   Sort Key: bucket
   Sort Method: quicksort  Memory: 25kB
   Buffers: shared hit=5
   ->  Seq Scan on metrics_daily  (cost=0.00..3.10 rows=1 width=29) (actual time=0.058..0.060 rows=1 loops=1)
         Filter: ((bucket >= '2026-01-01 00:00:00+00'::timestamp with time zone) AND (bucket <= '2026-04-30 00:00:00+00'::timestamp with time zone) AND (user_id = 'fcd434aa-2201-4060-aeb2-f44c77aa0683'::uuid))
         Rows Removed by Filter: 62
         Buffers: shared hit=2
 Planning:
   Buffers: shared hit=103
 Planning Time: 1.617 ms
 Execution Time: 0.293 ms
(12 rows)

```

## GET /users/:id/metrics?granularity=hourly

```
                                                                                                    QUERY PLAN                                                                                                    
------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
 Sort  (cost=7.16..7.16 rows=1 width=27) (actual time=0.135..0.136 rows=1 loops=1)
   Sort Key: bucket
   Sort Method: quicksort  Memory: 25kB
   Buffers: shared hit=6
   ->  Seq Scan on metrics_hourly  (cost=0.00..7.15 rows=1 width=27) (actual time=0.071..0.072 rows=1 loops=1)
         Filter: ((bucket >= '2026-01-01 00:00:00+00'::timestamp with time zone) AND (bucket <= '2026-04-30 00:00:00+00'::timestamp with time zone) AND (user_id = 'fcd434aa-2201-4060-aeb2-f44c77aa0683'::uuid))
         Rows Removed by Filter: 236
         Buffers: shared hit=3
 Planning:
   Buffers: shared hit=103
 Planning Time: 1.430 ms
 Execution Time: 0.277 ms
(12 rows)

```

## winRateByEmotionalState

```
                                                 QUERY PLAN                                                  
-------------------------------------------------------------------------------------------------------------
 Seq Scan on winrate_by_emotion  (cost=0.00..1.62 rows=5 width=15) (actual time=0.036..0.041 rows=5 loops=1)
   Filter: (user_id = 'fcd434aa-2201-4060-aeb2-f44c77aa0683'::uuid)
   Rows Removed by Filter: 45
   Buffers: shared hit=1
 Planning:
   Buffers: shared hit=78
 Planning Time: 1.531 ms
 Execution Time: 0.154 ms
(8 rows)

```

## planAdherenceScore (rolling 10)

```
                                                   QUERY PLAN                                                    
-----------------------------------------------------------------------------------------------------------------
 Seq Scan on plan_adherence_rolling  (cost=0.00..1.12 rows=1 width=10) (actual time=0.021..0.022 rows=1 loops=1)
   Filter: (user_id = 'fcd434aa-2201-4060-aeb2-f44c77aa0683'::uuid)
   Rows Removed by Filter: 9
   Buffers: shared hit=1
 Planning:
   Buffers: shared hit=67
 Planning Time: 1.101 ms
 Execution Time: 0.145 ms
(8 rows)

```

## sessionTiltIndex (avg over date range)

```
                                                                            QUERY PLAN                                                                             
-------------------------------------------------------------------------------------------------------------------------------------------------------------------
 Aggregate  (cost=2593.78..2593.79 rows=1 width=8) (actual time=34.466..34.469 rows=1 loops=1)
   Buffers: shared hit=825 read=330
   ->  Hash Join  (cost=654.23..2582.19 rows=4634 width=3) (actual time=5.953..33.732 rows=4658 loops=1)
         Hash Cond: (s.id = st.session_id)
         Buffers: shared hit=825 read=330
         ->  Seq Scan on sessions s  (cost=0.00..1741.66 rows=70964 width=16) (actual time=0.041..16.031 rows=71454 loops=1)
               Filter: ((started_at >= '2026-01-01 00:00:00+00'::timestamp with time zone) AND (started_at <= '2026-04-30 00:00:00+00'::timestamp with time zone))
               Rows Removed by Filter: 57
               Buffers: shared hit=341 read=328
         ->  Hash  (cost=595.86..595.86 rows=4670 width=19) (actual time=5.786..5.787 rows=4663 loops=1)
               Buckets: 8192  Batches: 1  Memory Usage: 297kB
               Buffers: shared hit=484 read=2
               ->  Bitmap Heap Scan on session_tilt st  (cost=56.48..595.86 rows=4670 width=19) (actual time=0.569..4.354 rows=4663 loops=1)
                     Recheck Cond: (user_id = 'fcd434aa-2201-4060-aeb2-f44c77aa0683'::uuid)
                     Heap Blocks: exact=481
                     Buffers: shared hit=484 read=2
                     ->  Bitmap Index Scan on session_tilt_user  (cost=0.00..55.31 rows=4670 width=0) (actual time=0.437..0.437 rows=4663 loops=1)
                           Index Cond: (user_id = 'fcd434aa-2201-4060-aeb2-f44c77aa0683'::uuid)
                           Buffers: shared hit=5
 Planning:
   Buffers: shared hit=287 read=1 dirtied=3
 Planning Time: 4.637 ms
 Execution Time: 34.740 ms
(23 rows)

```

UPDATE user_subscription SET month_limit=0 WHERE plan_id='pro' AND month_limit<>0;
